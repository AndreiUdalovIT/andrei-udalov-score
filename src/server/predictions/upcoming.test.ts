import { PGlite } from '@electric-sql/pglite';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { strengthModelOptions } from '@/lib/config/model-strengths';
import { MATCH_STATUSES } from '@/lib/types/football';

import * as schema from '../db/schema';
import { publishSyncedPredictions, publishUpcomingPredictions } from './upcoming';

const databaseState = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  failReads: false,
  beforeBatch: undefined as (() => void) | undefined,
  beforeExecute: undefined as (() => void | Promise<void>) | undefined,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  cacheLife() {
    throw new Error('prediction jobs must load fresh inputs');
  },
  cacheTag() {
    throw new Error('prediction jobs must load fresh inputs');
  },
}));
vi.mock('../db/client', () => ({
  get db() {
    const database = databaseState.database;
    if (!database) throw new Error('test database is unavailable');
    if (databaseState.failReads) {
      throw new Error('postgresql://user:private-token@database.example');
    }
    return {
      select: database.select.bind(database),
      // Read batches execute real SQL through the same PGlite instance.
      batch(queries: PromiseLike<unknown>[]) {
        databaseState.beforeBatch?.();
        return Promise.all(queries);
      },
      async execute(query: SQL) {
        await databaseState.beforeExecute?.();
        return database.execute(query);
      },
    };
  },
}));

let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let window: { dataCutoff: Date; until: Date };

function fixture(
  id: number,
  overrides: Partial<typeof schema.matches.$inferInsert> = {},
): typeof schema.matches.$inferInsert {
  return {
    id,
    competitionId: 2014,
    season: 2026,
    stage: 'REGULAR_SEASON',
    status: 'TIMED',
    utcDate: new Date(window.dataCutoff.getTime() + 3_600_000),
    lastUpdated: window.dataCutoff,
    duration: 'REGULAR',
    homeTeamId: 1,
    awayTeamId: 2,
    ...overrides,
  };
}

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

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  databaseState.failReads = false;
  databaseState.beforeBatch = undefined;
  databaseState.beforeExecute = undefined;
  window = {
    dataCutoff: new Date(Date.now() - 60_000),
    until: new Date(Date.now() + 7 * 86_400_000),
  };
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES
      (2014, 'PD', 'La Liga'), (2021, 'PL', 'Premier League'),
      (2001, 'CL', 'Champions League'), (2016, 'ELC', 'Championship');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (1, 'One', 'One', 'ONE'), (2, 'Two', 'Two', 'TWO'),
      (3, 'Three', 'Three', 'THR'), (4, 'Four', 'Four', 'FOU');
    INSERT INTO team_competitions (competition_id, season, team_id) VALUES
      (2014, 2025, 1), (2014, 2025, 2),
      (2014, 2026, 1), (2014, 2026, 2), (2014, 2026, 3);
  `);
  await database.insert(schema.matches).values([
    fixture(100, {
      season: 2025,
      status: 'FINISHED',
      utcDate: new Date('2025-11-01T00:00:00Z'),
      lastUpdated: new Date('2025-11-01T02:00:00Z'),
      homeGoals90: 2,
      awayGoals90: 1,
    }),
    fixture(101, {
      status: 'FINISHED',
      utcDate: new Date(window.dataCutoff.getTime() - 2 * 86_400_000),
      lastUpdated: new Date(window.dataCutoff.getTime() - 86_400_000),
      homeTeamId: 2,
      awayTeamId: 1,
      homeGoals90: 2,
      awayGoals90: 1,
    }),
    fixture(10),
    fixture(11, {
      utcDate: new Date(window.dataCutoff.getTime() + 7_200_000),
      homeTeamId: 2,
      awayTeamId: 1,
    }),
  ]);
});

describe('upcoming prediction publication', () => {
  it('loads strengths once and archives complete forecasts', async () => {
    const batch = vi.fn();
    databaseState.beforeBatch = batch;
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 2,
      skippedCount: 0,
    });
    expect(batch).toHaveBeenCalledOnce();
    const rows = await database.select().from(schema.predictions);
    expect(rows.map((row) => row.matchId)).toEqual([10, 11]);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'published',
        modelVersion: 'poisson-v1',
        dataCutoff: window.dataCutoff,
        expectedGoals: { home: 2, away: 1, lowData: true },
        modelOptions: {
          strengths: strengthModelOptions.PD,
          distribution: { tailTolerance: 1e-10, maxGoals: 64 },
        },
      });
      expect(row.probabilities.favorite).toBe('home');
      expect(row.probabilities.tailUpperBound).toBeLessThanOrEqual(1e-10);
      expect(row.probabilities.topScores).toHaveLength(3);
      expect(row.publishedAt).toEqual(row.recordedAt);
      expect(row.recordedAt.getTime()).toBeLessThan(row.kickoffAt.getTime());
    }
  });

  it('filters competition, season, status, open window and known distinct teams in SQL', async () => {
    const statuses = MATCH_STATUSES.filter(
      (status) => status !== 'TIMED' && status !== 'SCHEDULED',
    );
    await database
      .insert(schema.matches)
      .values([
        ...statuses.map((status, index) => fixture(200 + index, { status })),
        fixture(300, { competitionId: 2021 }),
        fixture(301, { season: 2025 }),
        fixture(302, { utcDate: window.dataCutoff }),
        fixture(303, { utcDate: window.until }),
        fixture(304, { utcDate: new Date(window.dataCutoff.getTime() - 1) }),
        fixture(305, { homeTeamId: null }),
        fixture(306, { awayTeamId: null }),
        fixture(307, { homeTeamId: 2 }),
        fixture(308, { status: 'SCHEDULED' }),
      ]);
    const result = await publishUpcomingPredictions('PD', 2026, window);
    expect(result).toEqual({ fixtureCount: 3, publishedCount: 3, skippedCount: 0 });
    const rows = await database.select().from(schema.predictions);
    expect(rows.map((row) => row.matchId).sort((a, b) => a - b)).toEqual([
      10, 11, 308,
    ]);
  });

  it('excludes results whose API update reaches the training cutoff', async () => {
    await database.insert(schema.matches).values(
      fixture(102, {
        status: 'FINISHED',
        utcDate: new Date(window.dataCutoff.getTime() - 86_400_000),
        lastUpdated: window.dataCutoff,
        homeGoals90: 99,
        awayGoals90: 99,
      }),
    );
    await publishUpcomingPredictions('PD', 2026, window);
    const rows = await database.select().from(schema.predictions);
    expect(rows.every((row) => row.expectedGoals.home === 2)).toBe(true);
    expect(rows.every((row) => row.expectedGoals.away === 1)).toBe(true);
  });

  it('skips teams with insufficient history or missing membership', async () => {
    await database
      .insert(schema.matches)
      .values([fixture(12, { homeTeamId: 3 }), fixture(13, { homeTeamId: 4 })]);
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 4,
      publishedCount: 2,
      skippedCount: 2,
    });
  });

  it('shares one cutoff across synced site competitions and uses CL strength settings', async () => {
    await database.insert(schema.teamCompetitions).values([
      { competitionId: 2001, season: 2026, teamId: 1 },
      { competitionId: 2001, season: 2026, teamId: 2 },
    ]);
    await database.insert(schema.matches).values([
      ...Array.from({ length: 3 }, (_, index) =>
        fixture(1000 + index, {
          competitionId: 2001,
          stage: 'LEAGUE_STAGE',
          status: 'FINISHED',
          utcDate: new Date(window.dataCutoff.getTime() - (3 + index) * 86_400_000),
          lastUpdated: new Date(
            window.dataCutoff.getTime() - (2 + index) * 86_400_000,
          ),
          homeGoals90: 2,
          awayGoals90: 1,
        }),
      ),
      fixture(2000, { competitionId: 2001, stage: 'LAST_16' }),
    ]);
    const cutoff = new Date(Date.now() - 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(cutoff);
    databaseState.beforeExecute = () => {
      vi.setSystemTime(new Date(cutoff.getTime() + 1));
    };

    await publishSyncedPredictions([
      { competitionCode: 'PD', season: 2026 },
      { competitionCode: 'CL', season: 2026 },
    ]);
    const rows = await database.select().from(schema.predictions);
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (prediction) => prediction.dataCutoff.getTime() === cutoff.getTime(),
      ),
    ).toBe(true);
    const row = rows.find((prediction) => prediction.matchId === 2000);
    expect(row?.modelOptions.strengths).toEqual(strengthModelOptions.CL);
    expect(row?.expectedGoals.lowData).toBe(false);
  });

  it('skips fixtures from an unconfigured season', async () => {
    await database.insert(schema.matches).values(fixture(12, { season: 2022 }));
    expect(await publishUpcomingPredictions('PD', 2022, window)).toEqual({
      fixtureCount: 1,
      publishedCount: 0,
      skippedCount: 1,
    });
  });

  it('skips forecasts when the training sample is empty', async () => {
    await database
      .delete(schema.matchObservations)
      .where(inArray(schema.matchObservations.matchId, [100, 101]));
    await database
      .delete(schema.matches)
      .where(inArray(schema.matches.id, [100, 101]));
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 0,
      skippedCount: 2,
    });
  });

  it('skips rates that exceed the probability calculation budget', async () => {
    await database
      .update(schema.matches)
      .set({ homeGoals90: 100, awayGoals90: 100 })
      .where(inArray(schema.matches.id, [100, 101]));
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 0,
      skippedCount: 2,
    });
    expect(await database.select().from(schema.predictions)).toEqual([]);
  });

  it('returns an empty summary before loading strengths when no fixtures qualify', async () => {
    await database
      .delete(schema.matchObservations)
      .where(inArray(schema.matchObservations.matchId, [10, 11]));
    await database
      .delete(schema.matches)
      .where(inArray(schema.matches.id, [10, 11]));
    databaseState.beforeBatch = () => {
      throw new Error('unexpected strength read');
    };
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 0,
      publishedCount: 0,
      skippedCount: 0,
    });
  });

  it('keeps a completed publication intact when the same cutoff is retried', async () => {
    await publishUpcomingPredictions('PD', 2026, window);
    const original = await database.select().from(schema.predictions);
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 0,
      skippedCount: 2,
    });
    expect(await database.select().from(schema.predictions)).toEqual(original);
  });

  it('retains a new forecast for a later data cutoff', async () => {
    await publishUpcomingPredictions('PD', 2026, window);
    const later = new Date(window.dataCutoff.getTime() + 1);
    expect(
      await publishUpcomingPredictions('PD', 2026, { ...window, dataCutoff: later }),
    ).toEqual({ fixtureCount: 2, publishedCount: 2, skippedCount: 0 });
    const rows = await database.select().from(schema.predictions);
    expect(rows).toHaveLength(4);
    expect(
      rows.filter((row) => row.dataCutoff.getTime() === later.getTime()),
    ).toHaveLength(2);
  });

  it('resumes after a partial failure while preserving the first saved row', async () => {
    let calls = 0;
    databaseState.beforeExecute = () => {
      calls += 1;
      if (calls === 2) throw new Error('database unavailable');
    };
    await expect(publishUpcomingPredictions('PD', 2026, window)).rejects.toThrow(
      'prediction could not be published',
    );
    const original = (await database.select().from(schema.predictions))[0]!;
    databaseState.beforeExecute = undefined;
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 1,
      skippedCount: 1,
    });
    const rows = await database.select().from(schema.predictions);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)).toEqual(original);
  });

  it('rechecks a fixture that starts during the calculation', async () => {
    databaseState.beforeExecute = async () => {
      databaseState.beforeExecute = undefined;
      await database
        .update(schema.matches)
        .set({ status: 'IN_PLAY' })
        .where(eq(schema.matches.id, 10));
    };
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 1,
      skippedCount: 1,
    });
    const rows = await database.select().from(schema.predictions);
    expect(rows.map((row) => row.matchId)).toEqual([11]);
  });

  it('keeps past kickoffs unpublished when retrying an older window', async () => {
    const previousCutoff = window.dataCutoff.getTime();
    window.dataCutoff = new Date(previousCutoff - 3 * 3_600_000);
    await database
      .update(schema.matches)
      .set({ utcDate: new Date(previousCutoff - 3_600_000) })
      .where(inArray(schema.matches.id, [10, 11]));
    expect(await publishUpcomingPredictions('PD', 2026, window)).toEqual({
      fixtureCount: 2,
      publishedCount: 0,
      skippedCount: 2,
    });
    expect(await database.select().from(schema.predictions)).toEqual([]);
  });

  it('copies caller-owned window dates before awaiting database work', async () => {
    const cutoff = new Date(window.dataCutoff.getTime());
    databaseState.beforeExecute = () => {
      window.dataCutoff.setTime(0);
      window.until.setTime(0);
    };
    await publishUpcomingPredictions('PD', 2026, window);
    const rows = await database.select().from(schema.predictions);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.dataCutoff.getTime() === cutoff.getTime())).toBe(
      true,
    );
  });

  it('cancels before reading fixtures', async () => {
    const reason = new Error('cancelled');
    databaseState.failReads = true;
    await expect(
      publishUpcomingPredictions('PD', 2026, {
        ...window,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it('cancels between publications and preserves completed rows', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    databaseState.beforeExecute = () => controller.abort(reason);
    await expect(
      publishUpcomingPredictions('PD', 2026, {
        ...window,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(await database.select().from(schema.predictions)).toHaveLength(1);
  });

  it.each(['invalid cutoff', 'invalid end', 'empty', 'reversed', 'future cutoff'])(
    'rejects an invalid window before SQL for %s',
    async (kind) => {
      if (kind === 'invalid cutoff') window.dataCutoff = new Date(NaN);
      if (kind === 'invalid end') window.until = new Date(NaN);
      if (kind === 'empty') window.until = new Date(window.dataCutoff.getTime());
      if (kind === 'reversed')
        window.until = new Date(window.dataCutoff.getTime() - 1);
      if (kind === 'future cutoff') {
        window.dataCutoff = new Date(Date.now() + 3_600_000);
      }
      databaseState.failReads = true;
      await expect(publishUpcomingPredictions('PD', 2026, window)).rejects.toThrow(
        'invalid prediction window',
      );
    },
  );

  it('sanitizes errors while loading fixtures', async () => {
    databaseState.failReads = true;
    await expect(publishUpcomingPredictions('PD', 2026, window)).rejects.toThrow(
      'upcoming fixtures could not be loaded',
    );
  });

  it('sanitizes errors while loading strength inputs', async () => {
    databaseState.beforeBatch = () => {
      throw new Error('postgresql://user:private-token@database.example');
    };
    await expect(publishUpcomingPredictions('PD', 2026, window)).rejects.toThrow(
      'competition strength data could not be loaded',
    );
  });

  it('publishes the next seven days with both window boundaries excluded', async () => {
    const cutoff = new Date(window.dataCutoff.getTime());
    const until = cutoff.getTime() + 7 * 86_400_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(cutoff);
    await database
      .insert(schema.matches)
      .values([
        fixture(300, { utcDate: cutoff }),
        fixture(301, { utcDate: new Date(until - 1) }),
        fixture(302, { utcDate: new Date(until) }),
        fixture(303, { utcDate: new Date(until + 1) }),
      ]);
    await publishSyncedPredictions([{ competitionCode: 'PD', season: 2026 }]);
    const rows = await database.select().from(schema.predictions);
    expect(rows.map((row) => row.matchId).sort((a, b) => a - b)).toEqual([
      10, 11, 301,
    ]);
    expect(rows.every((row) => row.dataCutoff.getTime() === cutoff.getTime())).toBe(
      true,
    );
  });

  it('selects site competitions when ELC has eligible fixtures', async () => {
    await database.insert(schema.teamCompetitions).values([
      { competitionId: 2016, season: 2025, teamId: 1 },
      { competitionId: 2016, season: 2025, teamId: 2 },
      { competitionId: 2016, season: 2026, teamId: 1 },
      { competitionId: 2016, season: 2026, teamId: 2 },
    ]);
    const source = await database
      .select()
      .from(schema.matches)
      .where(inArray(schema.matches.id, [10, 100, 101]));
    await database.insert(schema.matches).values(
      source.map((match, index) => ({
        ...match,
        id: 4000 + index,
        competitionId: 2016,
      })),
    );
    await publishSyncedPredictions([
      { competitionCode: 'PD', season: 2026 },
      { competitionCode: 'ELC', season: 2026 },
    ]);
    expect(await database.select().from(schema.predictions)).toHaveLength(2);
    expect(await publishUpcomingPredictions('ELC', 2026, window)).toEqual({
      fixtureCount: 1,
      publishedCount: 1,
      skippedCount: 0,
    });
  });

  it('forwards cancellation through the synced publication batch', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    databaseState.beforeExecute = () => controller.abort(reason);
    await expect(
      publishSyncedPredictions([{ competitionCode: 'PD', season: 2026 }], {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(await database.select().from(schema.predictions)).toHaveLength(1);
  });
});
