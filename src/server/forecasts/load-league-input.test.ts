import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { predictionModelConfig } from '@/lib/config/model-predictions';
import { createLeagueSimulation } from '@/lib/model/league-simulation';
import { projectSeasonStats } from '@/lib/model/season-stats';

import * as schema from '../db/schema';
import { createChampionsLeagueKnockoutForecasts } from './champions-league-knockout-forecasts';
import {
  loadChampionsLeaguePhaseInput,
  loadLeagueForecastInput,
} from './load-league-input';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('../db/client', () => ({
  get db() {
    if (state.database === null) throw new Error('test database unavailable');
    return state.database;
  },
}));

const competitionId = 2021;
const season = 2026;
const stage = 'REGULAR_SEASON';
const before = new Date('2026-11-12T00:00:00Z');
const capturedAt = new Date('2026-11-11T12:00:00Z');
const seed = [1, 2, 3, 4] as const;
const teamIds = Array.from({ length: 20 }, (_, index) => index + 1);
const upcomingId = 4020;
const upcomingDate = new Date('2026-11-22T15:00:00Z');
const matchDate = new Date('2026-11-10T12:00:00Z');
const matchUpdatedAt = new Date('2026-11-10T14:00:00Z');
const withoutResults = teamIds.map((teamId) => ({
  teamId,
  playedGames: 0,
  won: 0,
  draw: 0,
  lost: 0,
  points: 0,
  goalsFor: 0,
  goalsAgainst: 0,
}));

type MatchInsert = typeof schema.matches.$inferInsert;
const seasonFixtures = teamIds.flatMap((homeTeamId) =>
  teamIds
    .filter((awayTeamId) => awayTeamId !== homeTeamId)
    .map((awayTeamId) => ({
      id: 4000 + (homeTeamId - 1) * 20 + awayTeamId,
      homeTeamId,
      awayTeamId,
      homeGoals90: homeTeamId < awayTeamId ? 2 : 1,
      awayGoals90: homeTeamId < awayTeamId ? 1 : 2,
    })),
);
const matches: MatchInsert[] = seasonFixtures.map((fixture) => {
  const upcoming = fixture.id === upcomingId;
  return {
    ...fixture,
    competitionId,
    season,
    stage,
    status: upcoming ? 'TIMED' : 'FINISHED',
    utcDate: upcoming ? upcomingDate : matchDate,
    lastUpdated: matchUpdatedAt,
    duration: 'REGULAR',
    homeGoals90: upcoming ? null : fixture.homeGoals90,
    awayGoals90: upcoming ? null : fixture.awayGoals90,
  };
});

const standingsRows = projectSeasonStats(
  withoutResults,
  seasonFixtures
    .filter(({ id }) => id !== upcomingId)
    .map((fixture) => ({ ...fixture, source: 'simulated' })),
)!.map((row, index) => ({
  teamId: row.teamId,
  playedGames: row.playedGames,
  won: row.won,
  draw: row.draw,
  lost: row.lost,
  points: row.teamId === 1 ? row.points - 4 : row.points,
  goalsFor: row.goalsFor,
  goalsAgainst: row.goalsAgainst,
  stage,
  group: null,
  position: index + 1,
}));

const observations = matches.map(({ id, ...match }) => ({
  ...match,
  matchId: id,
  observedAt: capturedAt,
  source: 'change' as const,
}));
const upcomingObservation = observations.find(
  (match) => match.matchId === upcomingId,
)!;

let client: PGlite;
let database: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  state.database = database;
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)),
  });
  await database.insert(schema.competitions).values({
    id: competitionId,
    code: 'PL',
    name: 'Premier League',
  });
  await database.insert(schema.teams).values(
    teamIds.map((id) => ({
      id,
      name: 'Club ' + id,
      shortName: 'Club ' + id,
      tla: 'T' + id,
    })),
  );
  await database.insert(schema.matches).values(matches);
}, 15_000);

afterAll(async () => {
  state.database = null;
  await client?.close();
});

beforeEach(async () => {
  await client.exec(
    'TRUNCATE standings_snapshots, match_observations RESTART IDENTITY',
  );
  await database.insert(schema.matchObservations).values(observations);
});

async function saveTable(
  overrides: Partial<typeof schema.standingsSnapshots.$inferInsert> = {},
) {
  await database.insert(schema.standingsSnapshots).values({
    competitionId,
    season,
    capturedAt,
    source: 'official',
    rows: standingsRows,
    ...overrides,
  });
}

function load() {
  return loadLeagueForecastInput('PL', season, { before, seed });
}

describe('loadLeagueForecastInput', () => {
  it('builds a reproducible fixture input and retains the official deduction', async () => {
    await saveTable();
    await saveTable({
      source: 'reconstructed',
      rows: [],
      capturedAt: new Date(before.getTime() - 1),
    });
    await saveTable({ rows: [], capturedAt: before });
    await database.insert(schema.matchObservations).values({
      ...upcomingObservation,
      status: 'FINISHED',
      utcDate: matchDate,
      homeGoals90: 5,
      awayGoals90: 1,
      observedAt: before,
    });

    const result = await load();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('snapshot unavailable');

    expect(result.input).toMatchObject({
      competitionCode: 'PL',
      season,
      modelVersion: predictionModelConfig.version,
      dataCutoffMs: before.getTime(),
      seed,
    });
    expect(result.input.baseline[0]).toMatchObject({ teamId: 1, points: 107 });
    expect(result.input.fixtures).toHaveLength(380);
    expect(result.input.fixtures.find(({ id }) => id === 4002)).toEqual({
      id: 4002,
      homeTeamId: 1,
      awayTeamId: 2,
      kind: 'known-result',
      homeGoals90: 2,
      awayGoals90: 1,
    });
    expect(result.input.fixtures.filter(({ kind }) => kind === 'forecast')).toEqual([
      {
        id: upcomingId,
        homeTeamId: 1,
        awayTeamId: 20,
        kind: 'forecast',
        homeRate90: expect.any(Number),
        awayRate90: expect.any(Number),
      },
    ]);

    const simulation = createLeagueSimulation({ ...result.input, runs: 3 });
    simulation?.advance(3);
    expect(simulation?.result()?.inputSnapshot).toMatchObject({
      dataCutoffMs: before.getTime(),
      seed,
      runs: 3,
    });
  });

  it('requires an official table before the cutoff', async () => {
    await saveTable({ source: 'reconstructed' });
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'official-table',
    });
  });

  it('requires the full calendar', async () => {
    await saveTable();
    await database
      .delete(schema.matchObservations)
      .where(eq(schema.matchObservations.matchId, upcomingId));
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'incomplete-calendar',
    });
  });

  it('rejects an equal-sized calendar with a repeated home-away pair', async () => {
    await saveTable();
    await database
      .update(schema.matchObservations)
      .set({ awayTeamId: 2 })
      .where(eq(schema.matchObservations.matchId, upcomingId));
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'incomplete-calendar',
    });
  });

  it('reports a fixture whose kickoff is in the past but result is unknown', async () => {
    await saveTable();
    await database
      .update(schema.matchObservations)
      .set({ utcDate: matchDate })
      .where(eq(schema.matchObservations.matchId, upcomingId));
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'fixture-state',
      matchId: upcomingId,
    });
  });

  it('rejects standings whose totals diverge from the observed results', async () => {
    await saveTable({
      rows: standingsRows.map((row) =>
        row.teamId === 1 ? { ...row, goalsFor: row.goalsFor + 1 } : row,
      ),
    });
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'table-result-mismatch',
    });
  });

  it('reports missing model rates without substituting a score', async () => {
    await saveTable({
      rows: withoutResults.map((row, index) => ({
        ...row,
        stage,
        group: null,
        position: index + 1,
      })),
    });
    await database.update(schema.matchObservations).set({
      status: 'TIMED',
      utcDate: upcomingDate,
      homeGoals90: null,
      awayGoals90: null,
    });
    expect(await load()).toEqual({
      status: 'unavailable',
      reason: 'fixture-rates',
      matchId: 4002,
    });
  });

  it('leaves other formats and future cutoffs outside the domestic input', async () => {
    await expect(
      loadLeagueForecastInput('CL', season, { before, seed }),
    ).resolves.toEqual({
      status: 'unsupported',
    });
    await expect(
      loadLeagueForecastInput('PL', season, {
        before: new Date(Date.now() + 60_000),
        seed,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('loadChampionsLeaguePhaseInput', () => {
  const championsLeagueId = 2001;
  const clubs = Array.from({ length: 36 }, (_, index) => index + 1);
  const phase = 'LEAGUE_STAGE';
  const future = new Set([5001, 5126]);
  const phaseFixtures = clubs.flatMap((homeTeamId) =>
    [1, 2, 3, 4].map((distance) => ({
      id: 5000 + (homeTeamId - 1) * 4 + distance,
      homeTeamId,
      awayTeamId: ((homeTeamId - 1 + distance) % clubs.length) + 1,
      homeGoals90: (homeTeamId + distance) % 4,
      awayGoals90: distance % 3,
    })),
  );
  const phaseMatches: MatchInsert[] = phaseFixtures.map((fixture) => {
    const scheduled = future.has(fixture.id);
    return {
      ...fixture,
      competitionId: championsLeagueId,
      season,
      stage: phase,
      status: scheduled ? 'TIMED' : 'FINISHED',
      utcDate: scheduled ? upcomingDate : matchDate,
      lastUpdated: matchUpdatedAt,
      duration: 'REGULAR',
      homeGoals90: scheduled ? null : fixture.homeGoals90,
      awayGoals90: scheduled ? null : fixture.awayGoals90,
    };
  });
  const phaseTable = projectSeasonStats(
    clubs.map((teamId) => ({ ...withoutResults[0]!, teamId })),
    phaseFixtures
      .filter((fixture) => !future.has(fixture.id))
      .map((fixture) => ({ ...fixture, source: 'simulated' })),
  )!.map((row, index) => ({
    ...row,
    stage: phase,
    group: null,
    position: index + 1,
  }));

  beforeAll(async () => {
    await database.insert(schema.competitions).values({
      id: championsLeagueId,
      code: 'CL',
      name: 'Champions League',
    });
    await database.insert(schema.teams).values(
      clubs.slice(teamIds.length).map((id) => ({
        id,
        name: 'Club ' + id,
        shortName: 'Club ' + id,
        tla: 'T' + id,
      })),
    );
    await database.insert(schema.matches).values(phaseMatches);
  });

  beforeEach(async () => {
    await database.insert(schema.matchObservations).values(
      phaseMatches.map(({ id, ...match }) => ({
        ...match,
        matchId: id,
        observedAt: capturedAt,
        source: 'change' as const,
      })),
    );
  });

  function savePhaseTable(rows = phaseTable) {
    return saveTable({ competitionId: championsLeagueId, rows });
  }

  function loadPhase() {
    return loadChampionsLeaguePhaseInput(season, { before, seed });
  }

  it('builds the 36-team league phase using stored results and model rates', async () => {
    await savePhaseTable();
    await saveTable({
      competitionId: championsLeagueId,
      rows: [],
      capturedAt: before,
    });

    const result = await loadPhase();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('phase input unavailable');

    expect(result.input).toMatchObject({
      competitionCode: 'CL',
      season,
      dataCutoffMs: before.getTime(),
      seed,
    });
    expect(result.input.baseline).toHaveLength(36);
    expect(result.input.fixtures).toHaveLength(144);
    expect(result.input.fixtures.find(({ id }) => id === 5002)).toMatchObject({
      kind: 'known-result',
      homeGoals90: 3,
      awayGoals90: 2,
    });
    expect(result.input.fixtures.filter(({ kind }) => kind === 'forecast')).toEqual([
      {
        id: 5001,
        kind: 'forecast',
        homeTeamId: 1,
        awayTeamId: 2,
        homeRate90: expect.any(Number),
        awayRate90: expect.any(Number),
      },
      {
        id: 5126,
        kind: 'forecast',
        homeTeamId: 32,
        awayTeamId: 34,
        homeRate90: expect.any(Number),
        awayRate90: expect.any(Number),
      },
    ]);
    const phaseForecast = result.input.fixtures.find(
      (fixture) => fixture.id === 5001 && fixture.kind === 'forecast',
    );
    const forecasts = createChampionsLeagueKnockoutForecasts(
      structuredClone(result.knockoutStrengths),
    );
    expect(result.knockoutStrengths.league?.matchCount).toBe(142);
    if (phaseForecast?.kind !== 'forecast') throw new Error('expected phase rates');
    expect(forecasts.leg({ homeTeamId: 1, awayTeamId: 2, leg: 2 })).toMatchObject({
      homeRate90: phaseForecast.homeRate90,
      awayRate90: phaseForecast.awayRate90,
    });
    expect(createLeagueSimulation({ ...result.input, runs: 1 })).not.toBeNull();
  });

  it('withholds a calendar with repeated opponents even with balanced venues', async () => {
    await savePhaseTable();
    await database
      .update(schema.matchObservations)
      .set({ awayTeamId: 34 })
      .where(eq(schema.matchObservations.matchId, 5001));
    await database
      .update(schema.matchObservations)
      .set({ awayTeamId: 2 })
      .where(eq(schema.matchObservations.matchId, 5126));

    expect(await loadPhase()).toEqual({
      status: 'unavailable',
      reason: 'incomplete-calendar',
    });
  });

  it('withholds a complete fixture count with an unbalanced home schedule', async () => {
    await savePhaseTable();
    await database
      .update(schema.matchObservations)
      .set({ homeTeamId: 10 })
      .where(eq(schema.matchObservations.matchId, 5001));

    expect(await loadPhase()).toEqual({
      status: 'unavailable',
      reason: 'incomplete-calendar',
    });
  });

  it('reports unsupported point adjustments in the official league phase table', async () => {
    await savePhaseTable(
      phaseTable.map((row) =>
        row.teamId === 1 ? { ...row, points: row.points - 1 } : row,
      ),
    );

    expect(await loadPhase()).toEqual({
      status: 'unavailable',
      reason: 'table-result-mismatch',
    });
  });

  it('leaves the older group format unsupported', async () => {
    await expect(
      loadChampionsLeaguePhaseInput(2023, { before, seed }),
    ).resolves.toEqual({ status: 'unsupported' });
  });
});
