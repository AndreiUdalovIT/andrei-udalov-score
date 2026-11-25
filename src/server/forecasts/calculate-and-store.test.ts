import { PGlite } from '@electric-sql/pglite';
import type { SQL } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAMPIONS_LEAGUE_FORECAST_ALGORITHM,
  createChampionsLeagueForecast,
} from '@/lib/model/champions-league-forecast';
import type { ChampionsLeagueMatchProviders } from '@/lib/model/champions-league-simulation';
import type { ChampionsLeagueTwoLegMatchInputs } from '@/lib/model/champions-league-two-leg-round';
import type { SeasonCalendarFixture } from '@/lib/model/season-calendar-sampler';
import { projectSeasonStats } from '@/lib/model/season-stats';

import * as schema from '../db/schema';
import { calculateAndStoreSeasonForecast } from './calculate-and-store';
import { calculateChampionsLeagueForecast } from './calculate-champions-league-forecast';
import { restoreChampionsLeagueForecastInput } from './champions-league-knockout-snapshot';
import {
  loadChampionsLeagueKnockoutObservations,
  type ChampionsLeagueKnockoutObservation,
} from './load-knockout-observations';
import { loadChampionsLeaguePhaseInput } from './load-league-input';

const testState = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  loseResponse: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('./load-league-input', () => ({ loadChampionsLeaguePhaseInput: vi.fn() }));
vi.mock('./load-knockout-observations', () => ({
  loadChampionsLeagueKnockoutObservations: vi.fn(),
}));
vi.mock('../db/client', async () => {
  const { drizzle: neonDrizzle } = await import('drizzle-orm/neon-http');
  const tables = await import('../db/schema');
  const db = neonDrizzle.mock({ schema: tables, casing: 'snake_case' });
  Object.defineProperty(db, 'batch', {
    value: async (queries: readonly { getSQL(): SQL }[]) => {
      const database = testState.database;
      if (!database) throw new Error('test database unavailable');
      const results = await database.transaction(async (tx) => {
        const results = [];
        for (const query of queries) results.push(await tx.execute(query.getSQL()));
        return results;
      });
      if (testState.loseResponse) {
        testState.loseResponse = false;
        throw new Error('private database diagnostic');
      }
      return results;
    },
  });
  return { db };
});

let client: PGlite;
let database: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  testState.database = database;
  const migrationsFolder = fileURLToPath(
    new URL('../db/migrations', import.meta.url),
  );
  await migrate(database, { migrationsFolder });
  await client.exec(
    "INSERT INTO competitions (id, code, name) VALUES (2021, 'PL', 'Premier League'), (2001, 'CL', 'Champions League')",
  );
}, 15_000);

afterAll(async () => {
  testState.database = null;
  await client?.close();
});

beforeEach(async () => {
  testState.loseResponse = false;
  await client.exec('TRUNCATE season_forecasts RESTART IDENTITY');
});

const seed = [4294967295, 0, 2147483648, 1] as const;

function snapshot(
  size: number,
  fixtures: readonly Extract<SeasonCalendarFixture, { kind: 'known-result' }>[],
) {
  const empty = Array.from({ length: size }, (_, index) => ({
    teamId: index + 1,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  return {
    season: 2026,
    modelVersion: 'test-model-v1',
    dataCutoffMs: Date.now() - 10_000,
    seed,
    runs: 2,
    sampling: { maxGoals: 40, tailTolerance: 1e-10 },
    baseline: projectSeasonStats(
      empty,
      fixtures.map((fixture) => ({
        ...fixture,
        source: 'simulated',
      })),
    )!,
    fixtures,
  };
}

function leagueRequest() {
  const teamIds = Array.from({ length: 20 }, (_, index) => index + 1);
  const fixtures = teamIds.flatMap((homeTeamId) =>
    teamIds
      .filter((awayTeamId) => awayTeamId !== homeTeamId)
      .map((awayTeamId) => ({
        id: (homeTeamId - 1) * 20 + awayTeamId,
        homeTeamId,
        awayTeamId,
        kind: 'known-result' as const,
        homeGoals90: Number(homeTeamId < awayTeamId),
        awayGoals90: Number(awayTeamId < homeTeamId),
      })),
  );
  return {
    kind: 'league-table' as const,
    input: { ...snapshot(teamIds.length, fixtures), competitionCode: 'PL' as const },
  };
}

function tieInputs(
  firstTeamId: number,
  secondTeamId: number,
  firstLegHomeTeamId: number | null,
): ChampionsLeagueTwoLegMatchInputs {
  const firstHome = firstLegHomeTeamId ?? secondTeamId;
  const secondHome = firstHome === firstTeamId ? secondTeamId : firstTeamId;
  return {
    firstTeamId,
    secondTeamId,
    legs: [
      {
        leg: 1,
        kind: 'forecast',
        homeTeamId: firstHome,
        awayTeamId: secondHome,
        homeRate90: 0,
        awayRate90: 0,
      },
      {
        leg: 2,
        kind: 'forecast',
        homeTeamId: secondHome,
        awayTeamId: firstHome,
        homeRate90: 0,
        awayRate90: 0,
      },
    ],
    extraTime: { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
    penalties: { kind: 'forecast', firstTeamWinProbability: 1 },
  };
}

const matchProviders: ChampionsLeagueMatchProviders = {
  playOff: ({ ties }) =>
    ties.map((tie) => {
      const { firstTeamId, secondTeamId, ...inputs } = tieInputs(
        tie.seeded.teamId,
        tie.unseeded.teamId,
        tie.firstLegHomeTeamId,
      );
      return { ...inputs, seededTeamId: firstTeamId, unseededTeamId: secondTeamId };
    }),
  roundOf16: ({ ties }) =>
    ties.map((tie) =>
      tieInputs(
        tie.seeded.teamId,
        tie.playOffWinner.club.teamId,
        tie.firstLegHomeTeamId,
      ),
    ),
  quarterFinals: ({ ties }) =>
    ties.map((tie) =>
      tieInputs(
        tie.first.club.teamId,
        tie.second.club.teamId,
        tie.firstLegHomeTeamId,
      ),
    ),
  semiFinals: ({ ties }) =>
    ties.map((tie) =>
      tieInputs(
        tie.first.club.teamId,
        tie.second.club.teamId,
        tie.firstLegHomeTeamId,
      ),
    ),
  final: ({ silver, blue }) => ({
    silverTeamId: silver.club.teamId,
    blueTeamId: blue.club.teamId,
    regulation: { kind: 'forecast', silverNeutralRate90: 0, blueNeutralRate90: 0 },
    extraTime: { kind: 'forecast', silverNeutralRate30: 0, blueNeutralRate30: 0 },
    penalties: { kind: 'forecast', firstTeamWinProbability: 1 },
  }),
};

function championsLeagueRequest(matches = matchProviders) {
  const ids = Array.from({ length: 36 }, (_, index) => index + 1);
  const fixtures = ids.flatMap((homeTeamId) =>
    [1, 2, 3, 4].map((offset) => ({
      id: (homeTeamId - 1) * 4 + offset,
      homeTeamId,
      awayTeamId: ((homeTeamId - 1 + offset) % 36) + 1,
      kind: 'known-result' as const,
      homeGoals90: 1,
      awayGoals90: 0,
    })),
  );
  return {
    kind: 'champions-league-stages' as const,
    input: {
      ...snapshot(ids.length, fixtures),
      tieBreakContext: ids.map((teamId) => ({
        teamId,
        disciplinaryPoints: 0,
        clubCoefficient: 37 - teamId,
      })),
      matches,
    },
  };
}

function forecasts() {
  return database
    .select()
    .from(schema.seasonForecasts)
    .orderBy(schema.seasonForecasts.id);
}

describe('calculate and store season forecasts', () => {
  it('stores a complete league forecast with matching provenance', async () => {
    const request = leagueRequest();
    const { dataCutoffMs, modelVersion, runs } = request.input;
    const result = await calculateAndStoreSeasonForecast(request);
    const rows = await forecasts();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(result).toEqual({ status: 'stored', id: row.id });
    expect(row).toMatchObject({
      competitionId: 2021,
      season: 2026,
      kind: 'league-table',
      modelVersion,
      dataCutoff: new Date(dataCutoffMs),
      runs,
      seed,
      forecast: {
        inputSnapshot: { runs, modelVersion, dataCutoffMs, seed },
        forecast: {
          competitionCode: 'PL',
          runs,
          teams: expect.arrayContaining([
            expect.objectContaining({ teamId: 1, expectedPoints: 114 }),
          ]),
        },
      },
    });
    expect(row.calculatedAt.getTime()).toBeGreaterThanOrEqual(dataCutoffMs);
    expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(
      row.calculatedAt.getTime(),
    );
  });

  it('stores Champions League stage frequencies under the correct competition', async () => {
    const result = await calculateAndStoreSeasonForecast(championsLeagueRequest());
    const [row] = await forecasts();
    expect(result).toEqual({ status: 'stored', id: row!.id });
    expect(row).toMatchObject({
      competitionId: 2001,
      kind: 'champions-league-stages',
      runs: 2,
      forecast: {
        inputSnapshot: { seed, runs: 2 },
        teams: expect.arrayContaining([
          expect.objectContaining({
            teamId: 1,
            events: expect.objectContaining({
              directRoundOf16: { probability: 1, count: 2 },
            }),
          }),
        ]),
      },
    });
    expect(row!.forecast.inputSnapshot).not.toHaveProperty('matches');
  });

  it('reuses an identical committed result after a lost response and keeps a distinct seed', async () => {
    const request = leagueRequest();
    testState.loseResponse = true;
    await expect(calculateAndStoreSeasonForecast(request)).rejects.toThrow(
      /^season forecast could not be stored$/,
    );
    const [saved] = await forecasts();
    const repeats = await Promise.all([
      calculateAndStoreSeasonForecast(request),
      calculateAndStoreSeasonForecast(request),
    ]);
    expect(repeats).toEqual([
      { status: 'stored', id: saved!.id },
      { status: 'stored', id: saved!.id },
    ]);
    expect(await forecasts()).toHaveLength(1);
    expect(
      await calculateAndStoreSeasonForecast({
        ...request,
        input: { ...request.input, seed: [1, 2, 3, 4] },
      }),
    ).not.toEqual(repeats[0]);
    expect(await forecasts()).toHaveLength(2);
  });

  it('reports an unavailable scenario without persisting partial data', async () => {
    const result = await calculateAndStoreSeasonForecast(
      championsLeagueRequest({
        ...matchProviders,
        final: () => null,
      }),
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      detail: { run: 1, stage: 'final', reason: 'missing-match-inputs' },
    });
    expect(await forecasts()).toEqual([]);
  });

  it('reports a competition missing from the database', async () => {
    await client.exec("DELETE FROM competitions WHERE code = 'PL'");
    try {
      expect(await calculateAndStoreSeasonForecast(leagueRequest())).toEqual({
        status: 'competition-missing',
      });
      expect(await forecasts()).toEqual([]);
    } finally {
      await client.exec(
        "INSERT INTO competitions (id, code, name) VALUES (2021, 'PL', 'Premier League')",
      );
    }
  });

  it('rejects run counts outside the storage range and future cutoffs', async () => {
    const request = leagueRequest();
    await expect(
      calculateAndStoreSeasonForecast({
        ...request,
        input: { ...request.input, runs: 2_147_483_648 },
      }),
    ).rejects.toThrow(/positive PostgreSQL integer/);
    await expect(
      calculateAndStoreSeasonForecast({
        ...request,
        input: { ...request.input, dataCutoffMs: Date.now() + 60_000 },
      }),
    ).rejects.toThrow(/cutoff must not be in the future/);
    expect(await forecasts()).toEqual([]);
  });
});

describe('calculateChampionsLeagueForecast', () => {
  const loadPhase = vi.mocked(loadChampionsLeaguePhaseInput);
  const loadKnockout = vi.mocked(loadChampionsLeagueKnockoutObservations);
  const before = new Date('2026-11-12T00:00:00.000Z');

  function phaseInput() {
    const { season, modelVersion, sampling, baseline, fixtures, tieBreakContext } =
      championsLeagueRequest().input;
    const venue = {
      matchCount: 4,
      effectiveMatchCount: 4,
      attack: 1,
      defence: 1,
      lowData: false,
    };
    return {
      phase: {
        status: 'ready' as const,
        knockoutStrengths: {
          league: {
            matchCount: fixtures.length,
            effectiveMatchCount: fixtures.length,
            homeGoalsPerMatch: 1.4,
            awayGoalsPerMatch: 0.9,
          },
          teams: baseline.map(({ teamId }) => ({
            teamId,
            home: venue,
            away: venue,
          })),
        },
        input: {
          competitionCode: 'CL' as const,
          season,
          modelVersion,
          dataCutoffMs: before.getTime(),
          seed,
          sampling,
          baseline,
          fixtures,
        },
      },
      options: { before, seed, runs: 3, tieBreakContext },
    };
  }

  function finalPlaceholder(): ChampionsLeagueKnockoutObservation {
    return {
      matchId: 678,
      stage: 'FINAL',
      utcDate: new Date('2027-05-29T20:00:00.000Z'),
      observedAt: new Date(before.getTime() - 1),
      status: 'SCHEDULED',
      homeTeamId: null,
      awayTeamId: null,
      result: null,
    };
  }

  beforeEach(() => {
    loadPhase.mockReset();
    loadKnockout.mockReset();
  });

  it('stores a reproducible forecast and the inputs used for its knockout matches', async () => {
    const { phase, options } = phaseInput();
    const placeholder = finalPlaceholder();
    loadPhase.mockResolvedValue(phase);
    loadKnockout.mockResolvedValue([placeholder]);

    const stored = await calculateChampionsLeagueForecast(
      phase.input.season,
      options,
    );
    expect(stored).toEqual({ status: 'stored', id: expect.any(Number) });
    expect(loadPhase).toHaveBeenCalledWith(phase.input.season, { before, seed });
    expect(loadKnockout).toHaveBeenCalledWith(phase.input.season, before);

    const records = await forecasts();
    expect(records).toHaveLength(1);
    const forecast = records[0]?.forecast;
    if (
      forecast?.algorithm !== CHAMPIONS_LEAGUE_FORECAST_ALGORITHM ||
      forecast.knockoutSnapshot === undefined
    )
      throw new Error('expected a replayable Champions League forecast');
    const { knockoutSnapshot, ...savedResult } = forecast;
    expect(knockoutSnapshot).toEqual({
      version: 'ucl-observed-poisson-knockout-v1',
      strengths: phase.knockoutStrengths,
      observations: [
        {
          matchId: placeholder.matchId,
          stage: 'FINAL',
          status: 'SCHEDULED',
          homeTeamId: null,
          awayTeamId: null,
          result: null,
          kickoffMs: placeholder.utcDate.getTime(),
          observedAtMs: placeholder.observedAt.getTime(),
        },
      ],
    });
    const savedInput = { ...forecast.inputSnapshot, knockoutSnapshot };
    const restored = createChampionsLeagueForecast(
      restoreChampionsLeagueForecastInput(savedInput),
    );
    restored?.advance(forecast.inputSnapshot.runs);
    expect(restored?.result()).toEqual(savedResult);
    expect(
      await calculateAndStoreSeasonForecast({
        kind: 'champions-league-stages',
        input: savedInput,
      }),
    ).toEqual(stored);
    expect(await forecasts()).toHaveLength(1);
  });

  it('reports the first missing draw when the recorded schedule contains identified clubs', async () => {
    const { phase, options } = phaseInput();
    loadPhase.mockResolvedValue(phase);
    loadKnockout.mockResolvedValue([
      {
        ...finalPlaceholder(),
        homeTeamId: 1,
        awayTeamId: 2,
      },
    ]);

    expect(
      await calculateChampionsLeagueForecast(phase.input.season, options),
    ).toEqual({
      status: 'unavailable',
      reason: 'official-draw-required',
      stage: 'PLAYOFFS',
    });
    expect(await forecasts()).toEqual([]);
  });

  it('withholds a confirmed draw while the preceding league phase still has future matches', async () => {
    const { phase, options } = phaseInput();
    const [first, ...fixtures] = phase.input.fixtures;
    const upcoming = {
      id: first!.id,
      homeTeamId: first!.homeTeamId,
      awayTeamId: first!.awayTeamId,
      kind: 'forecast',
      homeRate90: 1.2,
      awayRate90: 0.8,
    } as const;
    loadPhase.mockResolvedValue({
      ...phase,
      input: { ...phase.input, fixtures: [upcoming, ...fixtures] },
    });
    loadKnockout.mockResolvedValue([]);

    expect(
      await calculateChampionsLeagueForecast(phase.input.season, {
        ...options,
        officialDraws: { playOff: { sourceReference: 'published draw', ties: [] } },
      }),
    ).toEqual({ status: 'unavailable', reason: 'incomplete-league-phase' });
    expect(await forecasts()).toEqual([]);
  });

  it('returns the input availability reason without loading knockout observations', async () => {
    const { phase, options } = phaseInput();
    const unavailable = { status: 'unavailable', reason: 'official-table' } as const;
    loadPhase.mockResolvedValue(unavailable);

    expect(
      await calculateChampionsLeagueForecast(phase.input.season, options),
    ).toEqual(unavailable);
    expect(loadKnockout).not.toHaveBeenCalled();
    expect(await forecasts()).toEqual([]);
  });
});
