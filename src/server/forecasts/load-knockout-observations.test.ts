import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKnockoutSampler } from '@/lib/model/knockout-sampler';

import * as schema from '../db/schema';
import { loadChampionsLeagueKnockoutObservations } from './load-knockout-observations';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
}));
vi.mock('server-only', () => ({}));
vi.mock('../db/client', () => ({
  get db() {
    if (state.database === null) throw new Error('test database unavailable');
    return state.database;
  },
}));

const season = 2026;
const championsLeagueId = 2001;
const premierLeagueId = 2021;
const before = new Date('2026-11-12T00:00:00Z');
const utcDate = new Date('2026-11-10T20:00:00Z');
const captured = new Date('2026-11-10T22:30:00Z');
const lastUpdated = new Date('2026-11-10T22:20:00Z');

let client: PGlite;
let database: PgliteDatabase<typeof schema>;

type Observation = typeof schema.matchObservations.$inferInsert;

function observation(
  matchId: number,
  fields: Partial<Observation> = {},
): Observation {
  return {
    matchId,
    competitionId: championsLeagueId,
    season,
    stage: 'PLAYOFFS',
    utcDate,
    status: 'FINISHED',
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals: 2,
    awayGoals: 1,
    homeGoals90: 2,
    awayGoals90: 1,
    duration: 'REGULAR',
    lastUpdated,
    observedAt: captured,
    source: 'change',
    ...fields,
  };
}

async function save(...rows: Observation[]) {
  await database.insert(schema.matchObservations).values(rows);
}

function load() {
  return loadChampionsLeagueKnockoutObservations(season, before);
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  state.database = database;
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)),
  });
  await database.insert(schema.competitions).values([
    { id: championsLeagueId, code: 'CL', name: 'Champions League' },
    { id: premierLeagueId, code: 'PL', name: 'Premier League' },
  ]);
  await database.insert(schema.teams).values([
    { id: 1, name: 'Club 1', shortName: 'Club 1', tla: 'CL1' },
    { id: 2, name: 'Club 2', shortName: 'Club 2', tla: 'CL2' },
  ]);
  await database.insert(schema.matches).values(
    Array.from({ length: 9 }, (_, index) => {
      const { matchId, ...row } = observation(index + 1);
      return { ...row, id: matchId };
    }),
  );
}, 15_000);

afterAll(async () => {
  state.database = null;
  await client?.close();
});

beforeEach(async () => {
  await client.exec('TRUNCATE match_observations RESTART IDENTITY');
});

describe('loadChampionsLeagueKnockoutObservations', () => {
  it('loads supported stages in order and keeps the latest state before the cutoff', async () => {
    const stages = ['PLAYOFFS', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];
    await save(
      ...stages.map((stage, index) => observation(index + 1, { stage })),
      observation(1, {
        homeGoals: 3,
        homeGoals90: 3,
        observedAt: new Date(before.getTime() - 1),
      }),
      observation(1, { homeGoals: 4, homeGoals90: 4, observedAt: before }),
      observation(6, { stage: 'LEAGUE_STAGE' }),
      observation(7, { stage: 'PLAYOFF_ROUND_1' }),
      observation(8, { competitionId: premierLeagueId }),
      observation(9, { season: 2025 }),
    );

    const matches = await load();
    expect(matches?.map(({ matchId, stage }) => [matchId, stage])).toEqual(
      stages.map((stage, index) => [index + 1, stage]),
    );
    expect(matches?.[0]).toEqual({
      matchId: 1,
      stage: 'PLAYOFFS',
      utcDate,
      observedAt: new Date(before.getTime() - 1),
      status: 'FINISHED',
      homeTeamId: 1,
      awayTeamId: 2,
      result: {
        regulation: {
          kind: 'known-result',
          homeTeamId: 1,
          awayTeamId: 2,
          homeGoals90: 3,
          awayGoals90: 1,
        },
        extraTime: null,
        penalties: null,
      },
    });
  });

  it('separates extra-time goals and shootout goals from the final score', async () => {
    await save(
      observation(1, {
        duration: 'EXTRA_TIME',
        homeGoals: 3,
        awayGoals: 2,
        homeGoals90: 2,
        awayGoals90: 2,
      }),
      observation(2, {
        stage: 'FINAL',
        duration: 'PENALTY_SHOOTOUT',
        homeGoals: 7,
        awayGoals: 8,
        homeGoals90: 1,
        awayGoals90: 1,
        homePenalties: 5,
        awayPenalties: 6,
      }),
    );

    const matches = await load();
    expect(matches?.[0]?.result).toMatchObject({
      extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 0 },
      penalties: null,
    });
    const final = matches?.[1]?.result;
    expect(final).toEqual({
      regulation: {
        kind: 'known-result',
        homeTeamId: 1,
        awayTeamId: 2,
        homeGoals90: 1,
        awayGoals90: 1,
      },
      extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 1 },
      penalties: { kind: 'known-result', winnerTeamId: 2 },
    });
    if (!final?.extraTime) throw new Error('expected recorded extra time');
    expect(
      createKnockoutSampler({
        firstTeamId: 1,
        secondTeamId: 2,
        legs: [{ leg: 1, ...final.regulation }],
        extraTime: final.extraTime,
        penalties: final.penalties,
        sampling: { tailTolerance: 1e-10, maxGoals: 64 },
      })?.sample(() => {
        throw new Error('observed result must not require a random draw');
      }).winnerTeamId,
    ).toBe(2);
  });

  it('keeps scheduled fixtures available for matching and leaves their result unknown', async () => {
    await save(
      observation(1, {
        status: 'TIMED',
        utcDate: new Date('2026-11-14T20:00:00Z'),
        homeGoals: null,
        awayGoals: null,
        homeGoals90: null,
        awayGoals90: null,
      }),
      observation(2, { status: 'AWARDED' }),
      observation(3, { observedAt: utcDate }),
    );

    const matches = await load();
    expect(
      matches?.map(({ matchId, status, result }) => ({ matchId, status, result })),
    ).toEqual([
      { matchId: 2, status: 'AWARDED', result: null },
      { matchId: 3, status: 'FINISHED', result: null },
      { matchId: 1, status: 'TIMED', result: null },
    ]);
  });

  it.each<Partial<Observation>>([
    { homeGoals90: null, duration: 'EXTRA_TIME' },
    { awayGoals: null },
    { homeGoals: 1, duration: 'EXTRA_TIME' },
    { homeGoals: 3 },
    { homePenalties: 5, awayPenalties: 4 },
    { duration: 'PENALTY_SHOOTOUT', homePenalties: 5 },
    { duration: 'PENALTY_SHOOTOUT', homePenalties: 5, awayPenalties: 5 },
    { duration: 'PENALTY_SHOOTOUT', homePenalties: 5, awayPenalties: 4 },
  ])('withholds an incomplete or inconsistent result (%j)', async (fields) => {
    await save(observation(1, fields));

    expect(await load()).toMatchObject([{ matchId: 1, result: null }]);
  });

  it('returns no matches before they are observed and leaves the older format unsupported', async () => {
    await save(observation(1, { observedAt: before }));
    await expect(load()).resolves.toEqual([]);
    await expect(
      loadChampionsLeagueKnockoutObservations(2023, before),
    ).resolves.toBeNull();
    await expect(
      loadChampionsLeagueKnockoutObservations(season, new Date(Date.now() + 60_000)),
    ).rejects.toThrow(RangeError);
  });
});
