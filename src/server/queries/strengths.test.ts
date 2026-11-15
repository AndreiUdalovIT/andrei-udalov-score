import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cacheLife, cacheTag } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { strengthModelOptions } from '@/lib/config/model-strengths';

import * as schema from '../db/schema';
import { getPromotionHistory, loadPromotionHistory } from './promotion-history';
import { getCompetitionStrengths, loadCompetitionStrengths } from './strengths';

const databaseState = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  failReads: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('../db/client', () => ({
  get db() {
    if (!databaseState.database) throw new Error('test database is unavailable');
    return Object.assign(databaseState.database, {
      // Every query runs against real PostgreSQL through the PGlite driver.
      batch(queries: PromiseLike<unknown>[]) {
        if (databaseState.failReads) {
          throw new Error('postgresql://user:private-token@database.example');
        }
        return Promise.all(queries);
      },
    });
  },
}));

const before = new Date('2026-11-16T00:00:00Z');
let client: PGlite;
let database: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  databaseState.database = database;
  await migrate(database, { migrationsFolder: 'src/server/db/migrations' });
}, 15_000);

afterAll(async () => {
  databaseState.database = null;
  await client?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  databaseState.failReads = false;
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES
      (2014, 'PD', 'La Liga'), (2021, 'PL', 'Premier League'),
      (2016, 'ELC', 'Championship');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (1, 'One', 'One', 'ONE'), (2, 'Two', 'Two', 'TWO'),
      (3, 'Three', 'Three', 'THR'), (4, 'Four', 'Four', 'FOU');
    INSERT INTO team_competitions (competition_id, season, team_id) VALUES
      (2014, 2025, 1), (2014, 2025, 2),
      (2014, 2026, 1), (2014, 2026, 2),
      (2021, 2025, 1), (2021, 2025, 2), (2021, 2025, 4),
      (2021, 2026, 1), (2021, 2026, 2), (2021, 2026, 3),
      (2016, 2025, 3), (2016, 2024, 4);
  `);
  const match = {
    competitionId: 2014,
    season: 2026,
    stage: 'REGULAR_SEASON',
    status: 'FINISHED' as const,
    utcDate: new Date('2026-11-10T00:00:00Z'),
    lastUpdated: new Date('2026-11-10T02:00:00Z'),
    duration: 'REGULAR' as const,
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals90: 2,
    awayGoals90: 1,
  };
  await database.insert(schema.matches).values([
    {
      ...match,
      id: 100,
      season: 2025,
      utcDate: new Date('2025-11-10T00:00:00Z'),
      lastUpdated: new Date('2025-11-10T02:00:00Z'),
    },
    { ...match, id: 101 },
    { ...match, id: 102, stage: 'LAST_16', homeGoals90: 99 },
    { ...match, id: 103, season: 2024, homeGoals90: 99 },
    { ...match, id: 104, competitionId: 2021, homeGoals90: 99 },
    { ...match, id: 105, lastUpdated: before, homeGoals90: 99 },
    {
      ...match,
      id: 106,
      status: 'TIMED',
      utcDate: new Date('2026-11-17T00:00:00Z'),
    },
    { ...match, id: 200, competitionId: 2016, season: 2025, homeTeamId: 3 },
    { ...match, id: 201, competitionId: 2016, season: 2024, homeTeamId: 4 },
    { ...match, id: 202, competitionId: 2021, season: 2025, homeTeamId: 4 },
  ]);
});

describe('fresh competition strengths', () => {
  it('scopes real SQL inputs by competition, seasons, main stage and cutoff', async () => {
    const result = await loadCompetitionStrengths('PD', 2026, before);
    expect(result).toMatchObject({
      competitionCode: 'PD',
      season: 2026,
      previousSeason: 2025,
      before,
      sample: { currentMatchCount: 1, previousMatchCount: 1 },
      league: { matchCount: 2, homeGoalsPerMatch: 2, awayGoalsPerMatch: 1 },
    });
    expect(result?.teams.map((team) => team.teamId)).toEqual([1, 2]);
    expect(result?.teams[0]?.home?.lowData).toBe(true);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it('reads updated results and memberships on the next call', async () => {
    const first = await loadCompetitionStrengths('PD', 2026, before);
    await database
      .update(schema.matches)
      .set({ homeGoals90: 6 })
      .where(eq(schema.matches.id, 101));
    await database
      .insert(schema.teamCompetitions)
      .values({ competitionId: 2014, season: 2026, teamId: 3 });

    const second = await loadCompetitionStrengths('PD', 2026, before);
    expect(first?.league?.homeGoalsPerMatch).toBe(2);
    expect(second?.league?.homeGoalsPerMatch).toBeGreaterThan(2);
    expect(second?.teams.map((team) => team.teamId)).toEqual([1, 2, 3]);
    expect(second?.teams[2]).toEqual({ teamId: 3, home: null, away: null });
  });

  it('applies the supplied cutoff and strength options', async () => {
    const earlier = await loadCompetitionStrengths(
      'PD',
      2026,
      new Date('2026-11-10T00:00:00Z'),
    );
    expect(earlier?.sample).toEqual({
      currentMatchCount: 0,
      previousMatchCount: 1,
    });
    const custom = await loadCompetitionStrengths('PD', 2026, before, {
      ...strengthModelOptions.PD,
      minEffectiveMatchCount: 1,
    });
    expect(custom?.teams[0]?.home?.lowData).toBe(false);
  });

  it('loads both promotion cohorts directly for PL', async () => {
    const result = await loadCompetitionStrengths('PL', 2026, before);
    expect(result?.promotion).toMatchObject({
      championshipSeason: 2025,
      calibrationSeason: 2025,
      previousPremierLeagueTeamCount: 3,
    });
    expect((await loadPromotionHistory(2026))?.promotedTeamIds).toEqual([3]);
    expect((await loadPromotionHistory(2025))?.promotedTeamIds).toEqual([4]);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it('observes changes in promotion history on subsequent reads', async () => {
    await loadCompetitionStrengths('PL', 2026, before);
    await database
      .delete(schema.teamCompetitions)
      .where(
        and(
          eq(schema.teamCompetitions.competitionId, 2021),
          eq(schema.teamCompetitions.season, 2025),
          eq(schema.teamCompetitions.teamId, 2),
        ),
      );
    await database
      .update(schema.matches)
      .set({ homeGoals90: 5 })
      .where(eq(schema.matches.id, 200));

    const result = await loadCompetitionStrengths('PL', 2026, before);
    const history = await loadPromotionHistory(2026);
    expect(result?.promotion?.previousPremierLeagueTeamCount).toBe(2);
    expect(history?.championshipMatches.map((match) => match.id)).toEqual([200]);
    expect(history?.championshipMatches[0]?.homeGoals90).toBe(5);
    expect(history?.premierLeagueMatches.map((match) => match.id)).toEqual([104]);
  });

  it('returns null for unconfigured seasons before reading the database', async () => {
    databaseState.failReads = true;
    expect(await loadCompetitionStrengths('PD', 2022, before)).toBeNull();
    expect(await loadPromotionHistory(2022)).toBeNull();
  });

  it('keeps cache lifetime and tags on the UI strength entry point', async () => {
    const fresh = await loadCompetitionStrengths('PD', 2026, before);
    expect(await getCompetitionStrengths('PD', 2026, before)).toEqual(fresh);
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('minutes');
    expect(cacheTag).toHaveBeenCalledExactlyOnceWith(
      'football:competition:PD',
      'football:competition:PD:season:2026',
      'football:competition:PD:season:2025',
    );
  });

  it('keeps caching on both promotion history cohorts for the UI', async () => {
    await getCompetitionStrengths('PL', 2026, before);
    expect(cacheLife).toHaveBeenCalledTimes(3);
    expect(cacheTag).toHaveBeenCalledWith(
      'football:competition:PL',
      'football:competition:ELC',
      'football:competition:PL:season:2025',
      'football:competition:PL:season:2024',
      'football:competition:ELC:season:2024',
    );
    vi.clearAllMocks();
    expect(await getPromotionHistory(2026)).toEqual(
      await loadPromotionHistory(2026),
    );
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('minutes');
  });

  it('sanitizes database failures from fresh strength reads', async () => {
    databaseState.failReads = true;
    await expect(loadCompetitionStrengths('PD', 2026, before)).rejects.toThrow(
      'competition strength data could not be loaded',
    );
  });

  it('sanitizes database failures from fresh promotion reads', async () => {
    databaseState.failReads = true;
    await expect(loadPromotionHistory(2026)).rejects.toThrow(
      'promotion history could not be loaded',
    );
  });
});
