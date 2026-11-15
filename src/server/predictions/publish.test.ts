import { PGlite } from '@electric-sql/pglite';
import { eq, type SQL } from 'drizzle-orm';
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
import { publishPrediction, type PredictionToPublish } from './publish';

const databaseState = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  beforeExecute: undefined as (() => void | Promise<void>) | undefined,
}));

vi.mock('server-only', () => ({}));
vi.mock('../db/client', () => ({
  db: {
    async execute(query: SQL) {
      await databaseState.beforeExecute?.();
      if (!databaseState.database) throw new Error('test database is unavailable');
      return databaseState.database.execute(query);
    },
  },
}));

let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let input: PredictionToPublish;

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
  databaseState.beforeExecute = undefined;
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES (2021, 'PL', 'Premier League');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (57, 'Arsenal', 'Arsenal', 'ARS'),
      (61, 'Chelsea', 'Chelsea', 'CHE'),
      (62, 'Liverpool', 'Liverpool', 'LIV');
  `);
  const fixture = {
    id: 100,
    status: 'TIMED' as const,
    utcDate: new Date(Date.now() + 3_600_000),
    homeTeamId: 57,
    awayTeamId: 61,
  };
  await database.insert(schema.matches).values({
    ...fixture,
    competitionId: 2021,
    season: 2026,
    stage: 'REGULAR_SEASON',
    duration: 'REGULAR',
    lastUpdated: new Date(),
  });
  input = {
    fixture,
    modelVersion: 'poisson-v1',
    dataCutoff: new Date(Date.now() - 60_000),
    expectedGoals: { home: 1.5, away: 1.501, lowData: false },
    modelOptions: {
      strengths: { ...strengthModelOptions.PL },
      distribution: { tailTolerance: 1e-10, maxGoals: 32 },
    },
  };
});

describe('prediction publication', () => {
  it('stores canonical probabilities, model settings and database publication time', async () => {
    const id = await publishPrediction(input);
    expect(id).toBeTypeOf('number');
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row).toMatchObject({
      id,
      matchId: input.fixture.id,
      source: 'published',
      modelVersion: input.modelVersion,
      homeTeamId: 57,
      awayTeamId: 61,
      kickoffAt: input.fixture.utcDate,
      dataCutoff: input.dataCutoff,
      expectedGoals: input.expectedGoals,
      modelOptions: input.modelOptions,
    });
    expect(row.probabilities.percentages).toEqual({ home: 38, draw: 24, away: 38 });
    expect(row.probabilities.favorite).toBe('away');
    expect(row.probabilities.outcomes.away).toBeGreaterThan(
      row.probabilities.outcomes.home,
    );
    expect(row.probabilities.topScores).toHaveLength(3);
    expect(row.probabilities.probabilities.length).toBeGreaterThan(1);
    expect(row.publishedAt).toEqual(row.recordedAt);
    expect(row.dataCutoff.getTime()).toBeLessThanOrEqual(row.calculatedAt.getTime());
    expect(row.calculatedAt.getTime()).toBeLessThanOrEqual(row.recordedAt.getTime());
    expect(row.recordedAt.getTime()).toBeLessThan(row.kickoffAt.getTime());
  });

  it('preserves a stored forecast on retry and records a new model version separately', async () => {
    const id = await publishPrediction(input);
    const before = (await database.select().from(schema.predictions))[0]!;
    input.expectedGoals.home = 3;
    expect(await publishPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toEqual([before]);

    input.modelVersion = 'poisson-v2';
    expect(await publishPrediction(input)).not.toBe(id);
    expect(await database.select().from(schema.predictions)).toHaveLength(2);
  });

  it('deduplicates overlapping publisher calls', async () => {
    const ids = await Promise.all([
      publishPrediction(input),
      publishPrediction(input),
    ]);
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await database.select().from(schema.predictions)).toHaveLength(1);
  });

  it.each(
    MATCH_STATUSES.filter((status) => status !== 'SCHEDULED' && status !== 'TIMED'),
  )('checks the current %s status at insertion', async (status) => {
    databaseState.beforeExecute = async () => {
      await database
        .update(schema.matches)
        .set({ status })
        .where(eq(schema.matches.id, 100));
    };
    expect(await publishPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toHaveLength(0);
  });

  it.each([
    { homeTeamId: 62 },
    { awayTeamId: 62 },
    { utcDate: new Date('2030-01-01T18:00:00Z') },
  ])('skips a changed fixture snapshot %j', async (change) => {
    databaseState.beforeExecute = async () => {
      await database
        .update(schema.matches)
        .set(change)
        .where(eq(schema.matches.id, 100));
    };
    expect(await publishPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toHaveLength(0);
  });

  it('skips a removed fixture', async () => {
    databaseState.beforeExecute = async () => {
      await database.delete(schema.matches).where(eq(schema.matches.id, 100));
    };
    expect(await publishPrediction(input)).toBeNull();
  });

  it('uses database time when the application clock is behind kickoff', async () => {
    input.fixture.utcDate = new Date('2020-01-01T18:00:00Z');
    input.dataCutoff = new Date('2020-01-01T17:00:00Z');
    await database
      .update(schema.matches)
      .set({ utcDate: input.fixture.utcDate })
      .where(eq(schema.matches.id, 100));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-01-01T17:59:00Z'));
    databaseState.beforeExecute = () => {
      vi.useRealTimers();
    };
    expect(await publishPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toHaveLength(0);
  });

  it('skips a calculation timestamp ahead of the database clock', async () => {
    input.fixture.utcDate = new Date('2100-01-01T18:00:00Z');
    input.dataCutoff = new Date('2090-01-01T17:00:00Z');
    await database
      .update(schema.matches)
      .set({ utcDate: input.fixture.utcDate })
      .where(eq(schema.matches.id, 100));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2090-01-01T17:59:00Z'));
    databaseState.beforeExecute = () => {
      vi.useRealTimers();
    };
    expect(await publishPrediction(input)).toBeNull();
  });

  it('captures input values before awaiting the database', async () => {
    const cutoff = new Date(input.dataCutoff.getTime());
    databaseState.beforeExecute = () => {
      input.dataCutoff.setUTCFullYear(2000);
      input.expectedGoals.home = 9;
      input.modelOptions.strengths.halfLifeDays = 1;
    };
    await publishPrediction(input);
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row.dataCutoff).toEqual(cutoff);
    expect(row.expectedGoals.home).toBe(1.5);
    expect(row.modelOptions.strengths.halfLifeDays).toBe(730);
  });

  it('keeps zero rates and the low-data flag', async () => {
    input.expectedGoals = { home: 0, away: 0, lowData: true };
    await publishPrediction(input);
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row.expectedGoals).toEqual(input.expectedGoals);
    expect(row.probabilities.outcomes).toEqual({ home: 0, draw: 1, away: 0 });
    expect(row.probabilities.favorite).toBe('draw');
  });

  it('skips an insufficient distribution budget', async () => {
    input.modelOptions.distribution.maxGoals = 0;
    expect(await publishPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toHaveLength(0);
  });

  it.each(['homeTeamId', 'awayTeamId'] as const)(
    'skips an unknown %s',
    async (field) => {
      input.fixture[field] = null;
      expect(await publishPrediction(input)).toBeNull();
    },
  );

  it('skips a future data cutoff', async () => {
    input.dataCutoff = new Date(Date.now() + 60_000);
    expect(await publishPrediction(input)).toBeNull();
  });

  const invalidInputs: [string, (value: PredictionToPublish) => void][] = [
    [
      'blank version',
      (value) => {
        value.modelVersion = ' ';
      },
    ],
    [
      'invalid cutoff',
      (value) => {
        value.dataCutoff = new Date(NaN);
      },
    ],
    [
      'invalid kickoff',
      (value) => {
        value.fixture.utcDate = new Date(NaN);
      },
    ],
    [
      'out-of-range ID',
      (value) => {
        value.fixture.id = 2 ** 31;
      },
    ],
    [
      'non-finite rate',
      (value) => {
        value.expectedGoals.home = NaN;
      },
    ],
    [
      'negative rate',
      (value) => {
        value.expectedGoals.away = -1;
      },
    ],
    [
      'zero half-life',
      (value) => {
        value.modelOptions.strengths.halfLifeDays = 0;
      },
    ],
    [
      'zero prior',
      (value) => {
        value.modelOptions.strengths.priorMatchCount = 0;
      },
    ],
    [
      'zero effective sample',
      (value) => {
        value.modelOptions.strengths.minEffectiveMatchCount = 0;
      },
    ],
    [
      'zero promotion cohort',
      (value) => {
        value.modelOptions.strengths.minTeamCount = 0;
      },
    ],
    [
      'invalid tolerance',
      (value) => {
        value.modelOptions.distribution.tailTolerance = 1;
      },
    ],
  ];
  it.each(invalidInputs)('rejects %s before inserting', async (_name, change) => {
    change(input);
    await expect(publishPrediction(input)).rejects.toThrow(
      'invalid prediction input',
    );
    expect(await database.select().from(schema.predictions)).toHaveLength(0);
  });

  it('sanitizes database errors', async () => {
    databaseState.beforeExecute = () => {
      throw new Error('postgresql://user:private-token@database.example');
    };
    const error: unknown = await publishPrediction(input).catch(
      (failure: unknown) => failure,
    );
    expect(error).toEqual(new Error('prediction could not be published'));
    expect(error).not.toHaveProperty('cause');
  });
});
