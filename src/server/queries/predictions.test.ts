import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cacheLife, cacheTag } from 'next/cache';
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
import { calculateMatchProbabilities } from '@/lib/model/match-probabilities';
import { MATCH_STATUSES } from '@/lib/types/football';

import * as schema from '../db/schema';
import {
  getMatchPrediction,
  getMatchPredictionAssessment,
  loadMatchPrediction,
  loadMatchPredictionAssessment,
} from './predictions';

const databaseState = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  failReads: false,
  beforeQuery: undefined as (() => void) | undefined,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('../db/client', () => ({
  get db() {
    if (databaseState.failReads) {
      throw new Error('postgresql://user:private-token@database.example');
    }
    if (!databaseState.database) throw new Error('test database is unavailable');
    return databaseState.database;
  },
}));

type PredictionInsert = typeof schema.predictions.$inferInsert;

let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let now: Date;
let kickoffAt: Date;

function prediction(overrides: Partial<PredictionInsert> = {}): PredictionInsert {
  const recordedAt = overrides.recordedAt ?? new Date(now.getTime() - 60_000);
  const distribution = { tailTolerance: 1e-10, maxGoals: 64 };
  return {
    matchId: 100,
    source: 'published',
    modelVersion: 'poisson-v1',
    homeTeamId: 57,
    awayTeamId: 61,
    kickoffAt,
    dataCutoff: new Date(recordedAt.getTime() - 60_000),
    calculatedAt: new Date(recordedAt.getTime() - 1000),
    recordedAt,
    publishedAt: recordedAt,
    expectedGoals: { home: 2, away: 1, lowData: false },
    probabilities: calculateMatchProbabilities(2, 1, distribution)!,
    modelOptions: { strengths: { ...strengthModelOptions.PL }, distribution },
    ...overrides,
  };
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, {
    schema,
    casing: 'snake_case',
    logger: {
      logQuery() {
        // Query parameters are bound before this database execution boundary.
        databaseState.beforeQuery?.();
      },
    },
  });
  databaseState.database = database;
  await migrate(database, { migrationsFolder: 'src/server/db/migrations' });
}, 15_000);

afterAll(async () => {
  databaseState.database = null;
  await client?.close();
});

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.clearAllMocks();
  databaseState.failReads = false;
  databaseState.beforeQuery = undefined;
  now = new Date();
  kickoffAt = new Date(now.getTime() + 3 * 3_600_000);
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES (2021, 'PL', 'Premier League');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (57, 'Arsenal', 'Arsenal', 'ARS'),
      (61, 'Chelsea', 'Chelsea', 'CHE'),
      (62, 'Liverpool', 'Liverpool', 'LIV');
  `);
  await database.insert(schema.matches).values(
    [100, 101].map((id) => ({
      id,
      competitionId: 2021,
      season: 2026,
      stage: 'REGULAR_SEASON',
      status: 'TIMED' as const,
      utcDate: kickoffAt,
      lastUpdated: now,
      duration: 'REGULAR' as const,
      homeTeamId: 57,
      awayTeamId: 61,
    })),
  );
});

describe('published match prediction lookup', () => {
  it('returns the complete saved forecast for the current fixture snapshot', async () => {
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction())
      .returning();
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(saved);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it('returns null when the fixture or a matching forecast is missing', async () => {
    expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
    expect(await loadMatchPrediction(999, 'poisson-v1')).toBeNull();
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toBeNull();
  });

  it('prefers the latest data cutoff even when older inputs were published later', async () => {
    await database.insert(schema.predictions).values(
      prediction({
        dataCutoff: new Date(now.getTime() - 120_000),
        recordedAt: new Date(now.getTime() - 10_000),
      }),
    );
    const [fresh] = await database
      .insert(schema.predictions)
      .values(
        prediction({
          dataCutoff: new Date(now.getTime() - 60_000),
          recordedAt: new Date(now.getTime() - 20_000),
        }),
      )
      .returning();
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(fresh);
  });

  it('scopes the query to the match, published source and requested model version', async () => {
    const [first] = await database
      .insert(schema.predictions)
      .values(prediction())
      .returning();
    const [second] = await database
      .insert(schema.predictions)
      .values(
        prediction({
          modelVersion: 'poisson-v2',
          recordedAt: new Date(now.getTime() - 5000),
        }),
      )
      .returning();
    await database.insert(schema.predictions).values([
      prediction({
        source: 'backtest',
        publishedAt: null,
        recordedAt: new Date(now.getTime() - 10_000),
      }),
      prediction({
        matchId: 101,
        recordedAt: new Date(now.getTime() - 1000),
      }),
    ]);
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(first);
    expect(await loadMatchPrediction(100, 'poisson-v2')).toEqual(second);
    expect(await loadMatchPrediction(100, 'poisson-v3')).toBeNull();
  });

  it('keeps exact model version identifiers', async () => {
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction({ modelVersion: ' poisson-v1 ' }))
      .returning();
    expect(await loadMatchPrediction(100, ' poisson-v1 ')).toEqual(saved);
    expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
  });

  it.each(['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'])(
    'uses database publication time when the application clock is %s',
    async (clock) => {
      const [visible] = await database
        .insert(schema.predictions)
        .values(prediction())
        .returning();
      await database.insert(schema.predictions).values(
        prediction({
          recordedAt: new Date(now.getTime() + 60_000),
        }),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(clock));
      databaseState.beforeQuery = () => {
        vi.useRealTimers();
      };
      expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(visible);
    },
  );

  it.each(MATCH_STATUSES)(
    'applies publication visibility for %s',
    async (status) => {
      const [saved] = await database
        .insert(schema.predictions)
        .values(prediction())
        .returning();
      await database
        .update(schema.matches)
        .set({ status })
        .where(eq(schema.matches.id, 100));
      const result = await loadMatchPrediction(100, 'poisson-v1');
      if (['POSTPONED', 'CANCELLED', 'AWARDED'].includes(status)) {
        expect(result).toBeNull();
      } else {
        expect(result).toEqual(saved);
      }
    },
  );

  it.each([
    { homeTeamId: 62 },
    { awayTeamId: 62 },
    { homeTeamId: 61, awayTeamId: 57 },
    { homeTeamId: null },
    { awayTeamId: null },
    { homeTeamId: 61 },
  ])(
    'requires matching participants for $homeTeamId / $awayTeamId',
    async (teams) => {
      await database.insert(schema.predictions).values(prediction());
      await database
        .update(schema.matches)
        .set(teams)
        .where(eq(schema.matches.id, 100));
      expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
    },
  );

  it.each([-86_400_000, 86_400_000])(
    'requires the current kickoff when it changes by %i ms',
    async (shift) => {
      await database.insert(schema.predictions).values(prediction());
      await database
        .update(schema.matches)
        .set({ utcDate: new Date(kickoffAt.getTime() + shift) })
        .where(eq(schema.matches.id, 100));
      expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
    },
  );

  it('selects the new snapshot after a postponed fixture gets a new kickoff', async () => {
    await database.insert(schema.predictions).values(prediction());
    const rescheduled = new Date(kickoffAt.getTime() + 86_400_000);
    await database
      .update(schema.matches)
      .set({ status: 'POSTPONED', utcDate: rescheduled })
      .where(eq(schema.matches.id, 100));
    expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
    await database
      .update(schema.matches)
      .set({ status: 'TIMED' })
      .where(eq(schema.matches.id, 100));
    expect(await loadMatchPrediction(100, 'poisson-v1')).toBeNull();
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction({ kickoffAt: rescheduled }))
      .returning();
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(saved);
  });

  it('preserves the prematch forecast when a completed result is corrected', async () => {
    const pastKickoff = new Date(now.getTime() - 3_600_000);
    await database
      .update(schema.matches)
      .set({
        status: 'FINISHED',
        utcDate: pastKickoff,
        homeGoals90: 2,
        awayGoals90: 0,
      })
      .where(eq(schema.matches.id, 100));
    const [saved] = await database
      .insert(schema.predictions)
      .values(
        prediction({
          kickoffAt: pastKickoff,
          recordedAt: new Date(pastKickoff.getTime() - 60_000),
        }),
      )
      .returning();
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(saved);
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: { outcome: 'home', correct: true },
    });
    await database
      .update(schema.matches)
      .set({ homeGoals90: 0, awayGoals90: 2, lastUpdated: now })
      .where(eq(schema.matches.id, 100));
    expect(await loadMatchPrediction(100, 'poisson-v1')).toEqual(saved);
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: { outcome: 'away', correct: false },
    });
  });

  it.each([
    { matchId: NaN, modelVersion: 'poisson-v1' },
    { matchId: Infinity, modelVersion: 'poisson-v1' },
    { matchId: 1.5, modelVersion: 'poisson-v1' },
    { matchId: 2 ** 31, modelVersion: 'poisson-v1' },
    { matchId: -(2 ** 31) - 1, modelVersion: 'poisson-v1' },
    { matchId: 100, modelVersion: '' },
    { matchId: 100, modelVersion: ' ' },
    { matchId: 100, modelVersion: '\t' },
  ])(
    'rejects invalid input before SQL for $matchId / $modelVersion',
    async (input) => {
      databaseState.failReads = true;
      await expect(
        loadMatchPrediction(input.matchId, input.modelVersion),
      ).rejects.toThrow('invalid prediction lookup');
    },
  );

  it('registers the match cache tag on the cached entry point', async () => {
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction())
      .returning();
    expect(await getMatchPrediction(100, 'poisson-v1')).toEqual(saved);
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('minutes');
    expect(cacheTag).toHaveBeenCalledExactlyOnceWith('football:matches');
  });

  it('sanitizes database failures without retaining a driver cause', async () => {
    databaseState.failReads = true;
    const result = loadMatchPrediction(100, 'poisson-v1');
    await expect(result).rejects.toThrow('match prediction could not be loaded');
    await expect(result).rejects.not.toHaveProperty('cause');
  });

  it('returns a pending assessment while the match is timed', async () => {
    await database
      .update(schema.matches)
      .set({ homeGoals90: 2, awayGoals90: 1 })
      .where(eq(schema.matches.id, 100));
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction())
      .returning();
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: null,
    });
  });

  it.each([
    {
      duration: 'EXTRA_TIME',
      homeGoals: 3,
      awayGoals: 1,
      homePenalties: null,
      awayPenalties: null,
    },
    {
      duration: 'PENALTY_SHOOTOUT',
      homeGoals: 5,
      awayGoals: 6,
      homePenalties: 4,
      awayPenalties: 5,
    },
  ] as const)('assesses the 90-minute draw after $duration', async (score) => {
    const pastKickoff = new Date(now.getTime() - 3_600_000);
    await database
      .update(schema.matches)
      .set({
        ...score,
        status: 'FINISHED',
        utcDate: pastKickoff,
        homeGoals90: 1,
        awayGoals90: 1,
      })
      .where(eq(schema.matches.id, 100));
    const [saved] = await database
      .insert(schema.predictions)
      .values(
        prediction({
          kickoffAt: pastKickoff,
          recordedAt: new Date(pastKickoff.getTime() - 60_000),
        }),
      )
      .returning();
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: { outcome: 'draw', correct: false },
    });
  });

  it.each([
    { homeGoals90: null, awayGoals90: 1 },
    { homeGoals90: 1, awayGoals90: null },
  ])(
    'waits for both 90-minute scores $homeGoals90 / $awayGoals90',
    async (score) => {
      const pastKickoff = new Date(now.getTime() - 3_600_000);
      await database
        .update(schema.matches)
        .set({
          ...score,
          status: 'FINISHED',
          utcDate: pastKickoff,
          homeGoals: 3,
          awayGoals: 1,
        })
        .where(eq(schema.matches.id, 100));
      const [saved] = await database
        .insert(schema.predictions)
        .values(
          prediction({
            kickoffAt: pastKickoff,
            recordedAt: new Date(pastKickoff.getTime() - 60_000),
          }),
        )
        .returning();
      expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
        prediction: saved,
        assessment: null,
      });
    },
  );

  it('assesses the stored raw favorite when displayed probabilities tie', async () => {
    const probabilities = calculateMatchProbabilities(1.5, 1.501, {
      tailTolerance: 1e-10,
      maxGoals: 64,
    })!;
    const pastKickoff = new Date(now.getTime() - 3_600_000);
    await database
      .update(schema.matches)
      .set({
        status: 'FINISHED',
        utcDate: pastKickoff,
        homeGoals90: 0,
        awayGoals90: 1,
      })
      .where(eq(schema.matches.id, 100));
    const [saved] = await database
      .insert(schema.predictions)
      .values(
        prediction({
          kickoffAt: pastKickoff,
          recordedAt: new Date(pastKickoff.getTime() - 60_000),
          expectedGoals: { home: 1.5, away: 1.501, lowData: false },
          probabilities,
        }),
      )
      .returning();
    expect(probabilities.percentages.home).toBe(probabilities.percentages.away);
    expect(await loadMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: { outcome: 'away', correct: true },
    });
  });

  it('registers cache lifetime and tag for the assessment entry point', async () => {
    const [saved] = await database
      .insert(schema.predictions)
      .values(prediction())
      .returning();
    expect(await getMatchPredictionAssessment(100, 'poisson-v1')).toEqual({
      prediction: saved,
      assessment: null,
    });
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('minutes');
    expect(cacheTag).toHaveBeenCalledExactlyOnceWith('football:matches');
  });
});
