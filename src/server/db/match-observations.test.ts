import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/matches.json';
import { matchSchema } from '@/lib/football-data/schemas/matches';

import { syncCompetitionMatches } from '../sync/matches';
import journal from './migrations/meta/_journal.json';
import * as schema from './schema';

const state = vi.hoisted(() => ({
  client: null as PGlite | null,
  getCompetitionMatches:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetitionMatches']>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getCompetitionMatches: state.getCompetitionMatches,
  }),
}));
vi.mock('./client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('./schema');
  const builder = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(builder, 'batch', {
    value: async (
      queries: readonly { toSQL(): { sql: string; params: unknown[] } }[],
    ) => {
      const client = state.client;
      if (!client) throw new Error('test database is unavailable');
      // Execute the sync's generated SQL and triggers in a real transaction.
      await client.transaction(async (tx) => {
        for (const query of queries) {
          const compiled = query.toSQL();
          await tx.query(compiled.sql, compiled.params);
        }
      });
    },
  });
  return { db: builder };
});

type MatchInsert = typeof schema.matches.$inferInsert;
const migrationsFolder = 'src/server/db/migrations';
const upcoming = matchSchema.parse(fixture.upcoming);
const finished = {
  ...upcoming,
  status: 'FINISHED' as const,
  lastUpdated: '2026-11-08T23:00:00Z',
  score: { ...upcoming.score, fullTime: { home: 2, away: 1 } },
};
const seedSql = `
  INSERT INTO competitions (id, code, name) VALUES
    (2021, 'PL', 'Premier League'), (2001, 'CL', 'Champions League');
  INSERT INTO teams (id, name, short_name, tla) VALUES
    (57, 'Arsenal', 'Arsenal', 'ARS'), (61, 'Chelsea', 'Chelsea', 'CHE'),
    (62, 'Everton', 'Everton', 'EVE'), (1076, 'Coventry', 'Coventry', 'COV');
`;

let client: PGlite;
let database: PgliteDatabase<typeof schema>;

function match(overrides: Partial<MatchInsert> = {}): MatchInsert {
  return {
    id: 100,
    competitionId: 2021,
    season: 2026,
    matchday: 10,
    stage: 'REGULAR_SEASON',
    utcDate: new Date('2026-11-06T20:00:00Z'),
    status: 'FINISHED',
    homeTeamId: 57,
    awayTeamId: 61,
    homeGoals: 2,
    awayGoals: 1,
    homeGoals90: 2,
    awayGoals90: 1,
    duration: 'REGULAR',
    homePenalties: null,
    awayPenalties: null,
    lastUpdated: new Date('2026-11-08T23:00:00Z'),
    ...overrides,
  };
}

function observations() {
  return database
    .select()
    .from(schema.matchObservations)
    .orderBy(schema.matchObservations.id);
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  state.client = client;
  await migrate(database, { migrationsFolder });
}, 15_000);

afterAll(async () => {
  state.client = null;
  await client?.close();
});

beforeEach(async () => {
  state.getCompetitionMatches.mockReset().mockResolvedValue({ matches: [finished] });
  await client.exec('TRUNCATE competitions, teams RESTART IDENTITY CASCADE;');
  await client.exec(seedSql);
});

describe('match observation migration', () => {
  it('upgrades existing rows atomically and retries without duplicating the baseline', async () => {
    const legacyClient = new PGlite();
    const legacy = drizzle(legacyClient, { schema, casing: 'snake_case' });
    try {
      const entry = journal.entries.find(
        (item) => item.tag === '0006_match_observations',
      );
      if (!entry) throw new Error('observation migration is missing');
      const migrations = readMigrationFiles({ migrationsFolder });
      const current = migrations.find((item) => item.folderMillis === entry.when);
      if (!current) throw new Error('observation SQL is missing');
      // Use the same transactional dialect migrator with the earlier migrations.
      const dialect = new PgDialect();
      // The migration API fixes the session generics to an empty schema.
      const session = legacy._.session as unknown as Parameters<
        PgDialect['migrate']
      >[1];
      await dialect.migrate(
        migrations.filter((item) => item.folderMillis < entry.when),
        session,
        { migrationsFolder },
      );
      await legacyClient.exec(seedSql);
      await legacy.insert(schema.matches).values([
        match({
          duration: 'PENALTY_SHOOTOUT',
          homeGoals: 3,
          awayGoals: 3,
          homeGoals90: 1,
          awayGoals90: 1,
          homePenalties: 5,
          awayPenalties: 4,
        }),
        match({
          id: 101,
          status: 'SCHEDULED',
          utcDate: new Date('2100-01-01T12:00:00Z'),
          homeTeamId: null,
          awayTeamId: null,
          matchday: null,
          homeGoals: null,
          awayGoals: null,
          homeGoals90: null,
          awayGoals90: null,
        }),
      ]);
      const original = await legacy
        .select()
        .from(schema.matches)
        .orderBy(schema.matches.id);

      await expect(
        dialect.migrate(
          [{ ...current, sql: [...current.sql, 'SELECT 1 / 0;'] }],
          session,
          { migrationsFolder },
        ),
      ).rejects.toThrow();
      expect(
        (
          await legacyClient.query(
            `SELECT to_regclass('public.match_observations') AS table_name, to_regprocedure('public.capture_match_observation()') AS function_name`,
          )
        ).rows,
      ).toEqual([{ table_name: null, function_name: null }]);
      expect(
        await legacy.select().from(schema.matches).orderBy(schema.matches.id),
      ).toEqual(original);
      expect(
        (
          await legacyClient.query(
            'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
          )
        ).rows,
      ).toEqual([{ count: 6 }]);

      const started = Date.now();
      await migrate(legacy, { migrationsFolder });
      const baseline = await legacy
        .select()
        .from(schema.matchObservations)
        .orderBy(schema.matchObservations.matchId);
      expect(baseline).toHaveLength(2);
      for (const [index, observation] of baseline.entries()) {
        const { id, matchId, source, observedAt, ...payload } = observation;
        expect(id).toBeGreaterThan(0);
        expect({ id: matchId, ...payload }).toEqual(original[index]);
        expect(source).toBe('baseline');
        expect(observedAt.getTime()).toBeGreaterThanOrEqual(started);
        expect(observedAt.getTime()).toBeLessThanOrEqual(Date.now());
      }
      await migrate(legacy, { migrationsFolder });
      expect(
        await legacy
          .select()
          .from(schema.matchObservations)
          .orderBy(schema.matchObservations.matchId),
      ).toEqual(baseline);
      expect(
        await legacy.select().from(schema.matches).orderBy(schema.matches.id),
      ).toEqual(original);
    } finally {
      await legacyClient.close();
    }
  }, 15_000);
});

describe('match observations', () => {
  it('captures the complete inserted state with the database receipt time', async () => {
    const started = Date.now();
    const [saved] = await database
      .insert(schema.matches)
      .values(match())
      .returning();
    const [observation] = await observations();
    if (!observation) throw new Error('inserted observation is missing');
    const { id, matchId, source, observedAt, ...payload } = observation;
    expect(id).toBeGreaterThan(0);
    expect({ id: matchId, ...payload }).toEqual(saved);
    expect(source).toBe('change');
    expect(observedAt.getTime()).toBeGreaterThanOrEqual(started);
    expect(observedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['competition', { competitionId: 2001 }],
    ['season', { season: 2025 }],
    ['round', { matchday: 11 }],
    ['stage', { stage: 'LAST_16' }],
    ['kickoff', { utcDate: new Date('2026-11-13T20:00:00Z') }],
    ['status', { status: 'POSTPONED' as const }],
    ['home team', { homeTeamId: 62 }],
    ['away team', { awayTeamId: 62 }],
    ['home score', { homeGoals: 3 }],
    ['away score', { awayGoals: 3 }],
    ['90-minute home score', { homeGoals90: 3 }],
    ['90-minute away score', { awayGoals90: 3 }],
    ['duration', { duration: 'EXTRA_TIME' as const }],
    ['home penalties', { homePenalties: 5 }],
    ['away penalties', { awayPenalties: 4 }],
    ['API timestamp', { lastUpdated: new Date('2100-01-01T00:00:00Z') }],
  ])('retains the earlier state when the %s changes', async (_name, changes) => {
    const [initial] = await database
      .insert(schema.matches)
      .values(match())
      .returning();
    const [updated] = await database
      .update(schema.matches)
      .set(changes)
      .where(eq(schema.matches.id, 100))
      .returning();
    const history = await observations();
    expect(history).toHaveLength(2);
    expect(
      history.map(({ id, matchId, observedAt, source, ...payload }) => {
        expect(id).toBeGreaterThan(0);
        expect(observedAt).toBeInstanceOf(Date);
        expect(source).toBe('change');
        return { id: matchId, ...payload };
      }),
    ).toEqual([initial, updated]);
  });

  it('skips an update that leaves every stored field equal', async () => {
    await database.insert(schema.matches).values(match());
    const initial = await observations();
    await database
      .update(schema.matches)
      .set({ homeGoals: 2, homePenalties: null })
      .where(eq(schema.matches.id, 100));
    expect(await observations()).toEqual(initial);
  });

  it('preserves nullable opponents and scores in future fixtures', async () => {
    await database.insert(schema.matches).values(
      match({
        status: 'SCHEDULED',
        utcDate: new Date('2100-01-01T12:00:00Z'),
        homeTeamId: null,
        awayTeamId: null,
        homeGoals: null,
        awayGoals: null,
        homeGoals90: null,
        awayGoals90: null,
      }),
    );
    expect(await observations()).toEqual([
      expect.objectContaining({
        status: 'SCHEDULED',
        homeTeamId: null,
        awayTeamId: null,
        homeGoals90: null,
        awayGoals90: null,
      }),
    ]);
  });

  it('rolls back the match and observation with their transaction', async () => {
    await expect(
      database.transaction(async (tx) => {
        await tx.insert(schema.matches).values(match());
        throw new Error('cancel transaction');
      }),
    ).rejects.toThrow('cancel transaction');
    expect(await database.select().from(schema.matches)).toEqual([]);
    expect(await observations()).toEqual([]);
  });

  it.each([
    ['unknown source', { source: sql`'unknown'` }, '23514'],
    ['missing source', { source: sql`NULL` }, '23502'],
    [
      'infinite observation time',
      { observedAt: sql`'infinity'::timestamptz` },
      '23514',
    ],
    [
      'negative infinite observation time',
      { observedAt: sql`'-infinity'::timestamptz` },
      '23514',
    ],
    ['missing observation time', { observedAt: sql`NULL` }, '23502'],
    ['missing match', { matchId: 99999 }, '23503'],
    ['missing competition', { competitionId: 99999 }, '23503'],
    ['missing home team', { homeTeamId: 99999 }, '23503'],
    ['missing away team', { awayTeamId: 99999 }, '23503'],
  ])('rejects %s in PostgreSQL', async (_name, changes, code) => {
    const [saved] = await database
      .insert(schema.matches)
      .values(match())
      .returning();
    if (!saved) throw new Error('inserted match is missing');
    const { id, ...payload } = saved;
    await expect(
      database
        .insert(schema.matchObservations)
        .values({ ...payload, matchId: id, source: 'baseline', ...changes }),
    ).rejects.toMatchObject({ cause: { code } });
    expect(await observations()).toHaveLength(1);
  });
});

describe('match sync observation capture', () => {
  it('records a new match once across identical sync retries', async () => {
    await expect(syncCompetitionMatches('PL')).resolves.toEqual({
      competitionCode: 'PL',
      matchCount: 1,
    });
    const initial = await observations();
    await syncCompetitionMatches('PL');
    expect(await observations()).toEqual(initial);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      matchId: finished.id,
      homeGoals90: 2,
      awayGoals90: 1,
      source: 'change',
    });
  });

  it('records equal-timestamp corrections and a return to the earlier score', async () => {
    await syncCompetitionMatches('PL');
    state.getCompetitionMatches.mockResolvedValueOnce({
      matches: [
        {
          ...finished,
          score: { ...finished.score, fullTime: { home: 3, away: 1 } },
        },
      ],
    });
    await syncCompetitionMatches('PL');
    await syncCompetitionMatches('PL');
    expect(
      (await observations()).map((row) => [
        row.homeGoals90,
        row.awayGoals90,
        row.lastUpdated,
      ]),
    ).toEqual([
      [2, 1, new Date(finished.lastUpdated)],
      [3, 1, new Date(finished.lastUpdated)],
      [2, 1, new Date(finished.lastUpdated)],
    ]);
  });

  it('ignores an older API state through the existing upsert freshness guard', async () => {
    await syncCompetitionMatches('PL');
    const initial = await observations();
    state.getCompetitionMatches.mockResolvedValueOnce({ matches: [upcoming] });
    await syncCompetitionMatches('PL');
    expect(await observations()).toEqual(initial);
    expect(await database.select().from(schema.matches)).toEqual([
      expect.objectContaining({
        status: 'FINISHED',
        homeGoals90: 2,
        lastUpdated: new Date(finished.lastUpdated),
      }),
    ]);
  });

  it('captures a postponement, new kickoff, and clearing of the earlier result', async () => {
    await syncCompetitionMatches('PL');
    state.getCompetitionMatches.mockResolvedValueOnce({
      matches: [
        {
          ...upcoming,
          status: 'POSTPONED',
          utcDate: '2026-11-13T20:00:00Z',
          lastUpdated: '2026-11-09T12:00:00Z',
        },
      ],
    });
    await syncCompetitionMatches('PL');
    const history = await observations();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      status: 'FINISHED',
      homeGoals90: 2,
      awayGoals90: 1,
    });
    expect(history[1]).toMatchObject({
      status: 'POSTPONED',
      utcDate: new Date('2026-11-13T20:00:00Z'),
      homeGoals: null,
      awayGoals: null,
      homeGoals90: null,
      awayGoals90: null,
      homePenalties: null,
      awayPenalties: null,
    });
  });

  it('keeps existing history for an empty API window', async () => {
    await syncCompetitionMatches('PL');
    const initial = await observations();
    state.getCompetitionMatches.mockResolvedValueOnce({ matches: [] });
    await syncCompetitionMatches('PL');
    expect(await observations()).toEqual(initial);
  });

  it('rolls back every match and observation when one match fails a foreign key', async () => {
    state.getCompetitionMatches.mockResolvedValueOnce({
      matches: [
        finished,
        {
          ...finished,
          id: finished.id + 1,
          homeTeam: { ...finished.homeTeam, id: 99999 },
        },
      ],
    });
    await expect(syncCompetitionMatches('PL')).rejects.toThrow(
      'competition matches could not be saved',
    );
    expect(await database.select().from(schema.matches)).toEqual([]);
    expect(await observations()).toEqual([]);
  });

  it('rolls back the match if writing its observation fails', async () => {
    await client.exec(
      `ALTER TABLE match_observations ADD CONSTRAINT reject_change CHECK (source <> 'change');`,
    );
    try {
      const result = syncCompetitionMatches('PL');
      await expect(result).rejects.toThrow('competition matches could not be saved');
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(await database.select().from(schema.matches)).toEqual([]);
      expect(await observations()).toEqual([]);
    } finally {
      await client.exec(
        'ALTER TABLE match_observations DROP CONSTRAINT reject_change;',
      );
    }
  });
});
