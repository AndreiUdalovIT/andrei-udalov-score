import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cacheLife, cacheTag } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { strengthModelOptions } from '@/lib/config/model-strengths';

import * as schema from '../db/schema';
import { loadObservedCompetitionStrengths } from './strengths';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  failReads: false,
  queryCount: 0,
  beforeDatabaseAccess: undefined as (() => void) | undefined,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('../db/client', () => ({
  get db() {
    if (state.failReads)
      throw new Error('postgresql://user:private-token@database.example');
    state.beforeDatabaseAccess?.();
    if (!state.database) throw new Error('test database is unavailable');
    return state.database;
  },
}));

type ObservationInsert = typeof schema.matchObservations.$inferInsert;
const options = {
  ...strengthModelOptions.PD,
  minEffectiveMatchCount: 1,
  minTeamCount: 1,
};
let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let before: Date;

function observation(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  const season = overrides.season ?? 2026;
  return {
    matchId: 100,
    competitionId: 2014,
    season,
    matchday: 1,
    stage: 'REGULAR_SEASON',
    utcDate: new Date(`${season}-11-10T12:00:00Z`),
    status: 'FINISHED',
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals: 2,
    awayGoals: 1,
    homeGoals90: 2,
    awayGoals90: 1,
    duration: 'REGULAR',
    homePenalties: null,
    awayPenalties: null,
    lastUpdated: new Date(`${season}-11-10T14:00:00Z`),
    observedAt: new Date('2026-11-10T15:00:00Z'),
    source: 'change',
    ...overrides,
  };
}

async function saveObservations(...records: ObservationInsert[]) {
  await database.insert(schema.matchObservations).values(records);
}

function promotionObservations(): ObservationInsert[] {
  const records = [
    observation({ matchId: 100, competitionId: 2021, season: 2024 }),
    observation({ matchId: 120, competitionId: 2021 }),
    observation({
      matchId: 121,
      competitionId: 2021,
      status: 'TIMED',
      utcDate: new Date('2026-11-20T12:00:00Z'),
      homeTeamId: 3,
      homeGoals90: null,
      awayGoals90: null,
    }),
  ];
  let matchId = 101;
  for (let index = 0; index < 3; index++) {
    records.push(
      observation({
        matchId: matchId++,
        competitionId: 2016,
        season: 2024,
        homeTeamId: 4,
        awayTeamId: 5,
      }),
      observation({
        matchId: matchId++,
        competitionId: 2016,
        season: 2024,
        homeTeamId: 5,
        awayTeamId: 4,
        homeGoals90: 1,
        awayGoals90: 2,
      }),
      observation({
        matchId: matchId++,
        competitionId: 2021,
        season: 2025,
        homeTeamId: 4,
        awayTeamId: 1,
      }),
      observation({
        matchId: matchId++,
        competitionId: 2021,
        season: 2025,
        homeTeamId: 2,
        awayTeamId: 4,
        homeGoals90: 1,
        awayGoals90: 2,
      }),
      observation({
        matchId: matchId++,
        competitionId: 2016,
        season: 2025,
        homeTeamId: 3,
        awayTeamId: 5,
      }),
      observation({
        matchId: matchId++,
        competitionId: 2016,
        season: 2025,
        homeTeamId: 5,
        awayTeamId: 3,
        homeGoals90: 1,
        awayGoals90: 2,
      }),
    );
  }
  return records;
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, {
    schema,
    casing: 'snake_case',
    logger: {
      logQuery() {
        state.queryCount++;
      },
    },
  });
  state.database = database;
  await migrate(database, { migrationsFolder: 'src/server/db/migrations' });
}, 15_000);

afterAll(async () => {
  state.database = null;
  await client?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.failReads = false;
  state.beforeDatabaseAccess = undefined;
  before = new Date('2026-11-16T00:00:00Z');
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES
      (2014, 'PD', 'La Liga'), (2021, 'PL', 'Premier League'),
      (2016, 'ELC', 'Championship'), (2001, 'CL', 'Champions League');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (1, 'One', 'One', 'ONE'), (2, 'Two', 'Two', 'TWO'),
      (3, 'Three', 'Three', 'THR'), (4, 'Four', 'Four', 'FOU'),
      (5, 'Five', 'Five', 'FIV'), (6, 'Six', 'Six', 'SIX');
    INSERT INTO team_competitions (competition_id, season, team_id) VALUES
      (2014, 2025, 5), (2014, 2026, 4), (2014, 2026, 5),
      (2021, 2026, 6), (2016, 2025, 6);
  `);
  await database.insert(schema.matches).values(
    Array.from({ length: 46 }, (_value, index) => ({
      id: 100 + index,
      competitionId: 2014,
      season: 2026,
      stage: 'REGULAR_SEASON',
      status: 'FINISHED' as const,
      utcDate: new Date('2026-11-10T12:00:00Z'),
      lastUpdated: new Date('2026-11-15T12:00:00Z'),
      homeTeamId: 4,
      awayTeamId: 5,
      homeGoals90: 99,
      awayGoals90: 99,
      duration: 'REGULAR' as const,
    })),
  );
  await database.delete(schema.matchObservations);
  state.queryCount = 0;
});

describe('observed competition strengths', () => {
  it('uses historical fixture membership, configured main stages, and the observation cutoff', async () => {
    await saveObservations(
      observation({ season: 2025 }),
      observation({ matchId: 101 }),
      observation({ matchId: 102, stage: 'LAST_16', homeGoals90: 99 }),
      observation({ matchId: 103, season: 2024, homeGoals90: 99 }),
      observation({ matchId: 104, competitionId: 2021, homeGoals90: 99 }),
      observation({
        matchId: 105,
        observedAt: new Date(before),
        homeGoals90: 99,
        homeTeamId: 6,
      }),
      observation({
        matchId: 106,
        status: 'TIMED',
        utcDate: new Date('2026-11-20T12:00:00Z'),
        homeTeamId: 3,
        awayTeamId: null,
        homeGoals90: null,
        awayGoals90: null,
      }),
    );
    state.queryCount = 0;
    const result = await loadObservedCompetitionStrengths('PD', 2026, before);
    expect(result).toMatchObject({
      competitionCode: 'PD',
      season: 2026,
      previousSeason: 2025,
      before,
      sample: { currentMatchCount: 1, previousMatchCount: 1 },
      league: { matchCount: 2, homeGoalsPerMatch: 2, awayGoalsPerMatch: 1 },
      history: { previousParticipantCount: 2, teamsWithoutPreviousMembership: [3] },
    });
    expect(result?.teams.map((team) => team.teamId)).toEqual([1, 2, 3]);
    expect(result?.teams.find((team) => team.teamId === 3)).toEqual({
      teamId: 3,
      home: null,
      away: null,
    });
    expect(state.queryCount).toBe(1);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it('uses a match captured by the database trigger through the observed strength entry point', async () => {
    await database.insert(schema.matches).values({
      id: 200,
      competitionId: 2014,
      season: 2026,
      stage: 'REGULAR_SEASON',
      status: 'FINISHED',
      utcDate: new Date('2026-11-10T12:00:00Z'),
      lastUpdated: new Date('2026-11-10T11:00:00Z'),
      homeTeamId: 1,
      awayTeamId: 2,
      homeGoals90: 2,
      awayGoals90: 1,
      duration: 'REGULAR',
    });
    const result = await loadObservedCompetitionStrengths(
      'PD',
      2026,
      new Date(Date.now() + 1),
    );
    expect(result?.sample.currentMatchCount).toBe(1);
    expect(result?.league?.homeGoalsPerMatch).toBe(2);
    expect(result?.teams.map((team) => team.teamId)).toEqual([1, 2]);
  });

  it('returns an empty sample before any fixture observations were collected', async () => {
    const result = await loadObservedCompetitionStrengths('PD', 2026, before);
    expect(result).toMatchObject({
      sample: { currentMatchCount: 0, previousMatchCount: 0 },
      league: null,
      teams: [],
      history: { previousParticipantCount: 0, teamsWithoutPreviousMembership: [] },
    });
  });

  it('replays the score version known at each cutoff', async () => {
    await saveObservations(
      observation(),
      observation({ observedAt: new Date('2026-11-17T12:00:00Z'), homeGoals90: 7 }),
    );
    const earlier = await loadObservedCompetitionStrengths('PD', 2026, before);
    const later = await loadObservedCompetitionStrengths(
      'PD',
      2026,
      new Date('2026-11-18T00:00:00Z'),
    );
    expect(earlier?.league?.homeGoalsPerMatch).toBe(2);
    expect(later?.league?.homeGoalsPerMatch).toBe(7);
    expect(earlier?.sample.currentMatchCount).toBe(1);
    expect(later?.sample.currentMatchCount).toBe(1);
  });

  it.each(['POSTPONED', 'CANCELLED', 'AWARDED', 'IN_PLAY', 'SUSPENDED'] as const)(
    'uses the latest %s state when assembling training data',
    async (status) => {
      await saveObservations(
        observation(),
        observation({
          status,
          observedAt: new Date('2026-11-12T12:00:00Z'),
          homeGoals90: null,
          awayGoals90: null,
        }),
      );
      const result = await loadObservedCompetitionStrengths('PD', 2026, before);
      expect(result?.sample.currentMatchCount).toBe(0);
      expect(result?.league).toBeNull();
      expect(result?.teams.map((team) => team.teamId)).toEqual([1, 2]);
    },
  );

  it('replays a postponement and a new kickoff', async () => {
    await saveObservations(
      observation(),
      observation({
        status: 'POSTPONED',
        observedAt: new Date('2026-11-12T12:00:00Z'),
        utcDate: new Date('2026-11-20T12:00:00Z'),
        homeGoals90: null,
        awayGoals90: null,
      }),
    );
    expect(
      (
        await loadObservedCompetitionStrengths(
          'PD',
          2026,
          new Date('2026-11-11T00:00:00Z'),
        )
      )?.sample.currentMatchCount,
    ).toBe(1);
    expect(
      (await loadObservedCompetitionStrengths('PD', 2026, before))?.sample
        .currentMatchCount,
    ).toBe(0);
  });

  it('applies the latest competition, season and stage before choosing training rows', async () => {
    await saveObservations(
      observation(),
      observation({
        competitionId: 2021,
        observedAt: new Date('2026-11-12T12:00:00Z'),
      }),
      observation({ matchId: 101 }),
      observation({
        matchId: 101,
        season: 2025,
        observedAt: new Date('2026-11-12T12:00:00Z'),
      }),
      observation({ matchId: 102 }),
      observation({
        matchId: 102,
        stage: 'LAST_16',
        observedAt: new Date('2026-11-12T12:00:00Z'),
      }),
    );
    const result = await loadObservedCompetitionStrengths('PD', 2026, before);
    expect(result?.sample).toEqual({ currentMatchCount: 0, previousMatchCount: 1 });
    expect(result?.league?.matchCount).toBe(1);
  });

  it('derives known participants from observed fixtures at all stages', async () => {
    await saveObservations(
      observation({
        stage: 'LAST_16',
        status: 'TIMED',
        homeTeamId: 3,
        awayTeamId: null,
        homeGoals90: null,
        awayGoals90: null,
      }),
    );
    const result = await loadObservedCompetitionStrengths('PD', 2026, before);
    expect(result?.teams).toEqual([{ teamId: 3, home: null, away: null }]);
    expect(result?.sample.currentMatchCount).toBe(0);
  });

  it('replays corrected opponents in historical membership', async () => {
    await saveObservations(
      observation(),
      observation({ homeTeamId: 3, observedAt: new Date('2026-11-12T12:00:00Z') }),
    );
    expect(
      (
        await loadObservedCompetitionStrengths(
          'PD',
          2026,
          new Date('2026-11-11T00:00:00Z'),
        )
      )?.teams.map((team) => team.teamId),
    ).toEqual([1, 2]);
    expect(
      (await loadObservedCompetitionStrengths('PD', 2026, before))?.teams.map(
        (team) => team.teamId,
      ),
    ).toEqual([2, 3]);
  });

  it('keeps the historical calculation stable as current memberships change', async () => {
    await saveObservations(
      observation({ season: 2025 }),
      observation({ matchId: 101 }),
    );
    const first = await loadObservedCompetitionStrengths('PD', 2026, before);
    await client.exec(
      `TRUNCATE team_competitions; INSERT INTO team_competitions (competition_id,season,team_id) VALUES (2014,2026,6);`,
    );
    expect(await loadObservedCompetitionStrengths('PD', 2026, before)).toEqual(
      first,
    );
  });

  it.each([
    new Date('2026-11-10T11:00:00Z'),
    new Date('2026-11-10T12:00:00Z'),
    new Date('2027-01-01T00:00:00Z'),
  ])('uses the observed result with API timestamp %s', async (lastUpdated) => {
    await saveObservations(observation({ lastUpdated }));
    expect(
      (await loadObservedCompetitionStrengths('PD', 2026, before))?.sample
        .currentMatchCount,
    ).toBe(1);
  });

  it('applies configured main-stage changes between CL seasons', async () => {
    await saveObservations(
      observation({ competitionId: 2001, season: 2023, stage: 'GROUP_STAGE' }),
      observation({
        matchId: 101,
        competitionId: 2001,
        season: 2023,
        stage: 'LEAGUE_STAGE',
        homeGoals90: 99,
      }),
      observation({
        matchId: 102,
        competitionId: 2001,
        season: 2024,
        stage: 'LEAGUE_STAGE',
        homeGoals90: 3,
      }),
      observation({
        matchId: 103,
        competitionId: 2001,
        season: 2024,
        stage: 'GROUP_STAGE',
        homeGoals90: 99,
      }),
    );
    const result = await loadObservedCompetitionStrengths('CL', 2024, before);
    expect(result?.sample).toEqual({ currentMatchCount: 1, previousMatchCount: 1 });
    expect(result?.league?.homeGoalsPerMatch).toBeGreaterThan(2);
    expect(result?.league?.homeGoalsPerMatch).toBeLessThan(3);
    expect(
      result?.teams.every((team) => team.home === null && team.away === null),
    ).toBe(true);
  });

  it('uses observed previous membership when only the current season is configured', async () => {
    await saveObservations(
      observation({ season: 2022 }),
      observation({ matchId: 101, season: 2023 }),
    );
    const result = await loadObservedCompetitionStrengths('PD', 2023, before);
    expect(result).toMatchObject({
      previousSeason: null,
      sample: { currentMatchCount: 1, previousMatchCount: 0 },
      history: { previousParticipantCount: 2, teamsWithoutPreviousMembership: [] },
    });
  });

  it('makes baseline results available from the recorded collection start', async () => {
    await saveObservations(
      observation({ source: 'baseline', observedAt: new Date(before) }),
    );
    expect(
      (await loadObservedCompetitionStrengths('PD', 2026, before))?.teams,
    ).toEqual([]);
    expect(
      (
        await loadObservedCompetitionStrengths(
          'PD',
          2026,
          new Date(before.getTime() + 1),
        )
      )?.sample.currentMatchCount,
    ).toBe(1);
  });

  it('captures cutoff and model settings before loading observations', async () => {
    await saveObservations(
      observation({ season: 2025 }),
      observation({ matchId: 101 }),
    );
    const settings = { ...options };
    const expectedBefore = new Date(before);
    state.beforeDatabaseAccess = () => {
      before.setTime(0);
      settings.minEffectiveMatchCount = 0;
    };
    const result = await loadObservedCompetitionStrengths(
      'PD',
      2026,
      before,
      settings,
    );
    expect(result?.before).toEqual(expectedBefore);
    expect(result?.sample.currentMatchCount).toBe(1);
  });

  it('returns null for an unconfigured season before accessing the database', async () => {
    state.failReads = true;
    expect(await loadObservedCompetitionStrengths('PD', 2022, before)).toBeNull();
  });

  it('rejects an invalid cutoff before accessing the database', async () => {
    state.failReads = true;
    await expect(
      loadObservedCompetitionStrengths('PD', 2026, new Date(NaN)),
    ).rejects.toThrow(new RangeError('before must be a valid date'));
  });

  it('reports a sanitized observation read failure', async () => {
    state.failReads = true;
    const result = loadObservedCompetitionStrengths('PD', 2026, before);
    await expect(result).rejects.toThrow(
      new Error('competition match observations could not be loaded'),
    );
    await expect(result).rejects.not.toHaveProperty('cause');
  });
});

describe('observed PL promotion history', () => {
  it('builds both promotion cohorts and ELC priors in one SQL statement', async () => {
    await saveObservations(...promotionObservations());
    state.queryCount = 0;
    const result = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      before,
      options,
    );
    expect(state.queryCount).toBe(1);
    expect(result?.teams.map((team) => team.teamId)).toEqual([1, 2, 3]);
    expect(result?.history.teamsWithoutPreviousMembership).toEqual([3]);
    expect(result?.promotion).toMatchObject({
      championshipSeason: 2025,
      calibrationSeason: 2025,
      previousPremierLeagueTeamCount: 3,
      adjustment: { home: { teamCount: 1 }, away: { teamCount: 1 } },
    });
    expect(result?.promotion?.adjustment.home.attack).toBeGreaterThan(0);
    expect(result?.promotion?.adjustment.away.attack).toBeGreaterThan(0);
    const promoted = result?.teams.find((team) => team.teamId === 3);
    expect(promoted?.home).toMatchObject({
      matchCount: 0,
      championshipPrior: { matchCount: 3 },
    });
    expect(promoted?.away).toMatchObject({
      matchCount: 0,
      championshipPrior: { matchCount: 3 },
    });
  });

  it('keeps observed promotion cohorts stable as current membership tables change', async () => {
    await saveObservations(...promotionObservations());
    const first = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      before,
      options,
    );
    await client.exec(
      `INSERT INTO team_competitions (competition_id,season,team_id) VALUES (2021,2024,4),(2021,2025,3),(2016,2024,6);`,
    );
    expect(
      await loadObservedCompetitionStrengths('PL', 2026, before, options),
    ).toEqual(first);
  });

  it('applies late ELC calibration corrections at their recorded observation time', async () => {
    await saveObservations(...promotionObservations());
    const first = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      before,
      options,
    );
    const laterBaseline = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      new Date('2026-11-18T00:00:00Z'),
      options,
    );
    await saveObservations(
      observation({
        matchId: 101,
        competitionId: 2016,
        season: 2024,
        homeTeamId: 4,
        awayTeamId: 5,
        homeGoals90: 99,
        observedAt: new Date('2026-11-17T12:00:00Z'),
      }),
    );
    expect(
      await loadObservedCompetitionStrengths('PL', 2026, before, options),
    ).toEqual(first);
    const later = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      new Date('2026-11-18T00:00:00Z'),
      options,
    );
    expect(later?.promotion?.adjustment.home.attack).not.toBeCloseTo(
      laterBaseline?.promotion?.adjustment.home.attack ?? NaN,
      8,
    );
  });

  it('keeps the current PL season outside the historical calibration sample', async () => {
    await saveObservations(...promotionObservations());
    const first = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      before,
      options,
    );
    await saveObservations(
      observation({
        matchId: 122,
        competitionId: 2021,
        homeTeamId: 3,
        homeGoals90: 20,
      }),
    );
    const second = await loadObservedCompetitionStrengths(
      'PL',
      2026,
      before,
      options,
    );
    expect(second?.promotion?.adjustment).toEqual(first?.promotion?.adjustment);
    expect(second?.league).not.toEqual(first?.league);
  });

  it('applies the configured promotion coverage threshold', async () => {
    await saveObservations(...promotionObservations());
    const result = await loadObservedCompetitionStrengths('PL', 2026, before, {
      ...options,
      minTeamCount: strengthModelOptions.PL.minTeamCount,
    });
    expect(result?.promotion?.adjustment.home.teamCount).toBe(1);
    expect(result?.promotion?.adjustment.home.attack).toBeNull();
    expect(result?.teams.find((team) => team.teamId === 3)?.home).toBeNull();
  });

  it('handles the earliest configured PL season with unavailable calibration seasons', async () => {
    await saveObservations(observation({ competitionId: 2021, season: 2023 }));
    const result = await loadObservedCompetitionStrengths(
      'PL',
      2023,
      before,
      options,
    );
    expect(result?.sample.currentMatchCount).toBe(1);
    expect(result?.promotion).toMatchObject({
      championshipSeason: null,
      calibrationSeason: null,
      previousPremierLeagueTeamCount: 0,
    });
  });
});
