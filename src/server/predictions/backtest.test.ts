import { PGlite } from '@electric-sql/pglite';
import { eq, sql, type SQL } from 'drizzle-orm';
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
import { calculateMatchProbabilities } from '@/lib/model/match-probabilities';
import { MATCH_STATUSES } from '@/lib/types/football';

import * as schema from '../db/schema';
import { loadMatchPrediction } from '../queries/predictions';
import {
  storeObservedBacktestPrediction,
  storeObservedCompetitionBacktest,
  type BacktestPredictionToStore,
  type ObservedBacktestSettings,
} from './backtest';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  beforeExecute: undefined as (() => void | Promise<void>) | undefined,
  beforeDatabaseAccess: undefined as (() => void) | undefined,
  writeCalls: 0,
  failWriteAt: undefined as number | undefined,
  failReads: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('../db/client', () => ({
  get db() {
    if (state.failReads)
      throw new Error('postgresql://user:private-token@database.example');
    state.beforeDatabaseAccess?.();
    const database = state.database;
    if (!database) throw new Error('test database is unavailable');
    return {
      select: database.select.bind(database),
      selectDistinctOn: database.selectDistinctOn.bind(database),
      async execute(query: SQL) {
        state.writeCalls++;
        await state.beforeExecute?.();
        if (state.writeCalls === state.failWriteAt)
          throw new Error('postgresql://user:private-token@database.example');
        return database.execute(query);
      },
    };
  },
}));

type ObservationInsert = typeof schema.matchObservations.$inferInsert;
const day = 86_400_000;
let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let kickoff: Date;
let input: BacktestPredictionToStore;
let window: { from: Date; until: Date; resultsBefore: Date };

function observation(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  return {
    matchId: 100,
    competitionId: 2014,
    season: 2026,
    matchday: 1,
    stage: 'REGULAR_SEASON',
    utcDate: new Date(kickoff),
    status: 'TIMED',
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals: null,
    awayGoals: null,
    homeGoals90: null,
    awayGoals90: null,
    duration: 'REGULAR',
    homePenalties: null,
    awayPenalties: null,
    lastUpdated: new Date(kickoff.getTime() - 2 * day),
    observedAt: new Date(kickoff.getTime() - 2 * day),
    source: 'change',
    ...overrides,
  };
}

async function saveObservations(...rows: ObservationInsert[]) {
  await database.insert(schema.matchObservations).values(rows);
}

function settings(): ObservedBacktestSettings {
  return {
    modelVersion: input.modelVersion,
    modelOptions: {
      strengths: {
        ...strengthModelOptions.PD,
        minEffectiveMatchCount: 1,
        minTeamCount: 1,
      },
      distribution: { ...input.modelOptions.distribution },
    },
  };
}

async function backtestSample(twoFixtures = false) {
  await saveObservations(
    ...[101, 102].map((matchId, index) =>
      observation({
        matchId,
        status: 'FINISHED',
        utcDate: new Date(kickoff.getTime() - (7 - index) * day),
        observedAt: new Date(kickoff.getTime() - (7 - index) * day + 2 * 3_600_000),
        lastUpdated: new Date(kickoff.getTime() - (7 - index) * day + 2 * 3_600_000),
        homeGoals: 2,
        awayGoals: 1,
        homeGoals90: 2,
        awayGoals90: 1,
      }),
    ),
    observation({
      status: 'FINISHED',
      observedAt: new Date(kickoff.getTime() + 2 * 3_600_000),
      homeGoals: 1,
      awayGoals: 0,
      homeGoals90: 1,
      awayGoals90: 0,
    }),
  );
  if (twoFixtures)
    await saveObservations(
      observation({ matchId: 110 }),
      observation({
        matchId: 110,
        status: 'FINISHED',
        observedAt: new Date(kickoff.getTime() + 2 * 3_600_000),
        homeGoals: 1,
        awayGoals: 0,
        homeGoals90: 1,
        awayGoals90: 0,
      }),
    );
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { schema, casing: 'snake_case' });
  state.database = database;
  await migrate(database, { migrationsFolder: 'src/server/db/migrations' });
}, 15_000);

afterAll(async () => {
  state.database = null;
  await client?.close();
});
afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  state.beforeExecute = undefined;
  state.beforeDatabaseAccess = undefined;
  state.writeCalls = 0;
  state.failWriteAt = undefined;
  state.failReads = false;
  kickoff = new Date(Date.now() - 4 * day);
  window = {
    from: new Date(kickoff.getTime() - day),
    until: new Date(kickoff.getTime() + day),
    resultsBefore: new Date(kickoff.getTime() + 3 * day),
  };
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES (2014, 'PD', 'La Liga');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (1, 'One', 'One', 'ONE'), (2, 'Two', 'Two', 'TWO'), (3, 'Three', 'Three', 'THR');
  `);
  await database.insert(schema.matches).values(
    Array.from({ length: 26 }, (_value, index) => ({
      id: 100 + index,
      competitionId: 2014,
      season: 2026,
      stage: 'REGULAR_SEASON',
      status: 'FINISHED' as const,
      utcDate: new Date(kickoff),
      lastUpdated: new Date(kickoff.getTime() + 2 * 3_600_000),
      homeTeamId: 1,
      awayTeamId: 2,
      homeGoals90: 1,
      awayGoals90: 0,
      duration: 'REGULAR' as const,
    })),
  );
  await database.delete(schema.matchObservations);
  await saveObservations(observation());
  input = {
    fixture: { id: 100, utcDate: new Date(kickoff), homeTeamId: 1, awayTeamId: 2 },
    modelVersion: 'poisson-v1',
    dataCutoff: new Date(kickoff),
    expectedGoals: { home: 1.5, away: 1.501, lowData: false },
    modelOptions: {
      strengths: { ...strengthModelOptions.PD },
      distribution: { tailTolerance: 1e-10, maxGoals: 64 },
    },
  };
});

describe('observed backtest prediction storage', () => {
  it('stores canonical probabilities, observed provenance, and actual calculation and receipt times', async () => {
    const started = Date.now();
    const id = await storeObservedBacktestPrediction(input);
    expect(id).toBeTypeOf('number');
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row).toMatchObject({
      id,
      source: 'backtest',
      matchId: 100,
      modelVersion: input.modelVersion,
      homeTeamId: 1,
      awayTeamId: 2,
      kickoffAt: kickoff,
      dataCutoff: input.dataCutoff,
      expectedGoals: input.expectedGoals,
      publishedAt: null,
      modelOptions: {
        ...input.modelOptions,
        resultAvailability: { mode: 'observed', delayHours: null },
      },
    });
    expect(row.probabilities).toEqual(
      calculateMatchProbabilities(
        input.expectedGoals.home,
        input.expectedGoals.away,
        input.modelOptions.distribution,
      ),
    );
    expect(row.calculatedAt.getTime()).toBeGreaterThanOrEqual(started);
    expect(row.calculatedAt.getTime()).toBeGreaterThan(kickoff.getTime());
    expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(
      row.calculatedAt.getTime(),
    );
  });

  it('deduplicates retries and stores model versions independently', async () => {
    const id = await storeObservedBacktestPrediction(input);
    const original = await database.select().from(schema.predictions);
    input.expectedGoals.home = 3;
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toEqual(original);
    input.modelVersion = 'poisson-v2';
    expect(await storeObservedBacktestPrediction(input)).not.toBe(id);
    expect(await database.select().from(schema.predictions)).toHaveLength(2);
  });

  it('deduplicates overlapping storage calls through PostgreSQL', async () => {
    const ids = await Promise.all([
      storeObservedBacktestPrediction(input),
      storeObservedBacktestPrediction(input),
    ]);
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await database.select().from(schema.predictions)).toHaveLength(1);
  });

  it('keeps published and backtest rows in their separate sources', async () => {
    input.dataCutoff = new Date(kickoff.getTime() - 3_600_000);
    const probabilities = calculateMatchProbabilities(
      input.expectedGoals.home,
      input.expectedGoals.away,
      input.modelOptions.distribution,
    )!;
    const [published] = await database
      .insert(schema.predictions)
      .values({
        matchId: 100,
        source: 'published',
        modelVersion: input.modelVersion,
        homeTeamId: 1,
        awayTeamId: 2,
        kickoffAt: kickoff,
        dataCutoff: input.dataCutoff,
        calculatedAt: new Date(kickoff.getTime() - 2_700_000),
        recordedAt: new Date(kickoff.getTime() - 1_800_000),
        publishedAt: new Date(kickoff.getTime() - 1_800_000),
        expectedGoals: input.expectedGoals,
        probabilities,
        modelOptions: input.modelOptions,
      })
      .returning();
    await storeObservedBacktestPrediction(input);
    expect(await database.select().from(schema.predictions)).toHaveLength(2);
    expect((await loadMatchPrediction(100, input.modelVersion))?.id).toBe(
      published?.id,
    );
  });

  it('sets its own source and timestamps when unrelated input fields are supplied', async () => {
    await storeObservedBacktestPrediction(
      Object.assign(input, {
        source: 'published',
        publishedAt: new Date(0),
        calculatedAt: new Date(0),
        recordedAt: new Date(0),
      }),
    );
    expect((await database.select().from(schema.predictions))[0]).toMatchObject({
      source: 'backtest',
      publishedAt: null,
    });
    expect(
      (await database.select().from(schema.predictions))[0]?.calculatedAt.getTime(),
    ).toBeGreaterThan(kickoff.getTime());
  });

  it.each(MATCH_STATUSES)(
    'checks the latest historical %s status at insertion',
    async (status) => {
      await saveObservations(
        observation({ status, observedAt: new Date(kickoff.getTime() - day) }),
      );
      const id = await storeObservedBacktestPrediction(input);
      expect(id !== null).toBe(status === 'SCHEDULED' || status === 'TIMED');
    },
  );

  it('uses a changed current fixture while replaying its eligible historical state', async () => {
    state.beforeExecute = async () => {
      await database
        .update(schema.matches)
        .set({
          status: 'CANCELLED',
          utcDate: new Date(kickoff.getTime() + day),
          homeTeamId: 3,
        })
        .where(eq(schema.matches.id, 100));
    };
    expect(await storeObservedBacktestPrediction(input)).toBeTypeOf('number');
    expect((await database.select().from(schema.predictions))[0]).toMatchObject({
      homeTeamId: 1,
      awayTeamId: 2,
      kickoffAt: kickoff,
    });
  });

  it.each([{ homeTeamId: 3 }, { awayTeamId: 3 }, { utcDate: new Date(0) }])(
    'rejects a historical fixture mismatch %j',
    async (change) => {
      await saveObservations(
        observation({ ...change, observedAt: new Date(kickoff.getTime() - day) }),
      );
      expect(await storeObservedBacktestPrediction(input)).toBeNull();
    },
  );

  it.each(['homeTeamId', 'awayTeamId'] as const)(
    'skips an unknown input %s',
    async (field) => {
      input.fixture[field] = null;
      expect(await storeObservedBacktestPrediction(input)).toBeNull();
    },
  );

  it('skips repeated historical participants', async () => {
    input.fixture.awayTeamId = 1;
    await saveObservations(
      observation({ awayTeamId: 1, observedAt: new Date(kickoff.getTime() - day) }),
    );
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
  });

  it('skips a fixture with no historical observations or no current identity', async () => {
    await database.delete(schema.matchObservations);
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
    input.fixture.id = 99999;
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
  });

  it.each([-1, 0, 1])(
    'checks historical observation at cutoff offset %s milliseconds',
    async (offset) => {
      await database.delete(schema.matchObservations);
      await saveObservations(
        observation({ observedAt: new Date(input.dataCutoff.getTime() + offset) }),
      );
      expect((await storeObservedBacktestPrediction(input)) !== null).toBe(
        offset < 0,
      );
    },
  );

  it('chooses the latest equal-timestamp correction by row ID', async () => {
    const at = new Date(kickoff.getTime() - day);
    await saveObservations(
      observation({ status: 'CANCELLED', observedAt: at }),
      observation({ status: 'TIMED', observedAt: at }),
    );
    expect(await storeObservedBacktestPrediction(input)).toBeTypeOf('number');
  });

  it('compares database observation microseconds before choosing a fixture', async () => {
    const at = new Date(kickoff.getTime() - day).toISOString();
    const prefix = at.slice(0, -1);
    await database.insert(schema.matchObservations).values([
      {
        ...observation({ status: 'TIMED' }),
        observedAt: sql`${prefix + '900Z'}::timestamptz`,
      },
      { ...observation({ status: 'CANCELLED' }), observedAt: new Date(at) },
    ]);
    expect(await storeObservedBacktestPrediction(input)).toBeTypeOf('number');
  });

  it('skips a future data cutoff or one later than the fixture', async () => {
    state.failReads = true;
    input.dataCutoff = new Date(Date.now() + day);
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
    input.dataCutoff = new Date(kickoff.getTime() + 1);
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
  });

  it('skips insufficient probability budgets before database access', async () => {
    state.failReads = true;
    input.modelOptions.distribution.maxGoals = 0;
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
  });

  it('stores zero rates and the low-data flag', async () => {
    input.expectedGoals = { home: 0, away: 0, lowData: true };
    await storeObservedBacktestPrediction(input);
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row.expectedGoals).toEqual(input.expectedGoals);
    expect(row.probabilities.outcomes.draw).toBe(1);
  });

  it('uses the database receipt clock when the calculation clock is ahead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    state.beforeExecute = () => {
      vi.useRealTimers();
    };
    expect(await storeObservedBacktestPrediction(input)).toBeNull();
    expect(await database.select().from(schema.predictions)).toEqual([]);
  });

  it('captures the caller data before the database boundary', async () => {
    const expected = structuredClone(input);
    state.beforeDatabaseAccess = () => {
      input.dataCutoff.setTime(0);
      input.fixture.utcDate.setTime(0);
      input.expectedGoals.home = 9;
      input.modelOptions.strengths.halfLifeDays = 1;
    };
    await storeObservedBacktestPrediction(input);
    expect((await database.select().from(schema.predictions))[0]).toMatchObject({
      dataCutoff: expected.dataCutoff,
      kickoffAt: expected.fixture.utcDate,
      expectedGoals: expected.expectedGoals,
      modelOptions: {
        ...expected.modelOptions,
        resultAvailability: { mode: 'observed', delayHours: null },
      },
    });
  });

  it('reports a failed write without partial rows and supports retry', async () => {
    await client.exec(
      `ALTER TABLE predictions ADD CONSTRAINT reject_backtest CHECK (source <> 'backtest');`,
    );
    try {
      const result = storeObservedBacktestPrediction(input);
      await expect(result).rejects.toThrow(
        new Error('backtest prediction could not be stored'),
      );
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(await database.select().from(schema.predictions)).toEqual([]);
    } finally {
      await client.exec('ALTER TABLE predictions DROP CONSTRAINT reject_backtest;');
    }
    expect(await storeObservedBacktestPrediction(input)).toBeTypeOf('number');
  });

  const invalid: [string, (value: BacktestPredictionToStore) => void][] = [
    [
      'blank model version',
      (value) => {
        value.modelVersion = ' ';
      },
    ],
    [
      'invalid kickoff',
      (value) => {
        value.fixture.utcDate = new Date(NaN);
      },
    ],
    [
      'invalid cutoff',
      (value) => {
        value.dataCutoff = new Date(NaN);
      },
    ],
    [
      'out-of-range ID',
      (value) => {
        value.fixture.id = 2147483648;
      },
    ],
    [
      'non-finite rate',
      (value) => {
        value.expectedGoals.home = Infinity;
      },
    ],
    [
      'negative rate',
      (value) => {
        value.expectedGoals.away = -1;
      },
    ],
    [
      'invalid decay',
      (value) => {
        value.modelOptions.strengths.halfLifeDays = 0;
      },
    ],
    [
      'invalid promotion threshold',
      (value) => {
        value.modelOptions.strengths.minTeamCount = 0;
      },
    ],
    [
      'invalid tail',
      (value) => {
        value.modelOptions.distribution.tailTolerance = 1;
      },
    ],
    [
      'invalid goal limit',
      (value) => {
        value.modelOptions.distribution.maxGoals = -1;
      },
    ],
    [
      'caller-supplied provenance',
      (value) => {
        Object.assign(value.modelOptions, {
          resultAvailability: { mode: 'reconstructed', delayHours: 24 },
        });
      },
    ],
  ];
  it.each(invalid)(
    'rejects %s before accessing the database',
    async (_name, mutate) => {
      state.failReads = true;
      mutate(input);
      await expect(storeObservedBacktestPrediction(input)).rejects.toThrow(
        new RangeError('invalid backtest prediction input'),
      );
    },
  );
});

describe('observed competition backtest storage', () => {
  it('calculates observed walk-forward rows and stores their fixture identity and settings', async () => {
    await backtestSample();
    const model = settings();
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).toEqual({
      matchCount: 1,
      forecastCount: 1,
      storedCount: 1,
      skippedCount: 0,
      unavailableCount: 0,
    });
    const row = (await database.select().from(schema.predictions))[0]!;
    expect(row).toMatchObject({
      matchId: 100,
      source: 'backtest',
      dataCutoff: kickoff,
      kickoffAt: kickoff,
      homeTeamId: 1,
      awayTeamId: 2,
      modelVersion: model.modelVersion,
      publishedAt: null,
      modelOptions: {
        ...model.modelOptions,
        resultAvailability: { mode: 'observed', delayHours: null },
      },
    });
    expect(row.expectedGoals.home).toBeCloseTo(2, 12);
    expect(row.expectedGoals.away).toBeCloseTo(1, 12);
  });

  it('counts a result with no eligible historical forecast as unavailable', async () => {
    await database.delete(schema.matchObservations);
    await backtestSample();
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, settings()),
    ).toEqual({
      matchCount: 1,
      forecastCount: 0,
      storedCount: 0,
      skippedCount: 0,
      unavailableCount: 1,
    });
    expect(state.writeCalls).toBe(0);
  });

  it('returns an empty summary when evaluation results are absent', async () => {
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, settings()),
    ).toEqual({
      matchCount: 0,
      forecastCount: 0,
      storedCount: 0,
      skippedCount: 0,
      unavailableCount: 0,
    });
  });

  it('deduplicates reruns and records a new model version separately', async () => {
    await backtestSample();
    const model = settings();
    await storeObservedCompetitionBacktest('PD', 2026, window, model);
    const original = await database.select().from(schema.predictions);
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).toMatchObject({ forecastCount: 1, storedCount: 0, skippedCount: 1 });
    expect(await database.select().from(schema.predictions)).toEqual(original);
    model.modelVersion = 'poisson-v2';
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).toMatchObject({ storedCount: 1 });
    expect(await database.select().from(schema.predictions)).toHaveLength(2);
  });

  it('reports probability budget skips separately from missing model forecasts', async () => {
    await backtestSample();
    const model = settings();
    model.modelOptions.distribution.maxGoals = 0;
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).toEqual({
      matchCount: 1,
      forecastCount: 1,
      storedCount: 0,
      skippedCount: 1,
      unavailableCount: 0,
    });
  });

  it('resumes after a partially failed storage run', async () => {
    await backtestSample(true);
    state.failWriteAt = 2;
    await expect(
      storeObservedCompetitionBacktest('PD', 2026, window, settings()),
    ).rejects.toThrow('backtest prediction could not be stored');
    const first = await database.select().from(schema.predictions);
    expect(first).toHaveLength(1);
    state.failWriteAt = undefined;
    state.writeCalls = 0;
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, settings()),
    ).toEqual({
      matchCount: 2,
      forecastCount: 2,
      storedCount: 1,
      skippedCount: 1,
      unavailableCount: 0,
    });
    expect(
      (
        await database
          .select()
          .from(schema.predictions)
          .where(eq(schema.predictions.id, first[0]!.id))
      )[0],
    ).toEqual(first[0]);
  });

  it('honors cancellation before reading or writing', async () => {
    const controller = new AbortController();
    const reason = new Error('stop backtest');
    controller.abort(reason);
    state.failReads = true;
    await expect(
      storeObservedCompetitionBacktest('PD', 2026, window, {
        ...settings(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(state.writeCalls).toBe(0);
  });

  it('resumes after cancellation following the first in-flight write', async () => {
    await backtestSample(true);
    const controller = new AbortController();
    const reason = new Error('stop backtest');
    state.beforeExecute = () => {
      if (state.writeCalls === 1) controller.abort(reason);
    };
    await expect(
      storeObservedCompetitionBacktest('PD', 2026, window, {
        ...settings(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(await database.select().from(schema.predictions)).toHaveLength(1);
    state.beforeExecute = undefined;
    state.writeCalls = 0;
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, settings()),
    ).toMatchObject({ storedCount: 1, skippedCount: 1 });
  });

  it('captures the caller model configuration and window before database access', async () => {
    await backtestSample();
    const model = settings();
    const expected = structuredClone(model);
    state.beforeDatabaseAccess = () => {
      window.from.setTime(0);
      window.until.setTime(0);
      window.resultsBefore.setTime(0);
      model.modelVersion = 'changed';
      model.modelOptions.strengths.minEffectiveMatchCount = 0;
    };
    expect(
      await storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).toMatchObject({ storedCount: 1 });
    expect((await database.select().from(schema.predictions))[0]).toMatchObject({
      modelVersion: expected.modelVersion,
      modelOptions: { strengths: expected.modelOptions.strengths },
    });
  });

  it('returns null for an unconfigured season and validates model settings first', async () => {
    state.failReads = true;
    expect(
      await storeObservedCompetitionBacktest('PD', 2022, window, settings()),
    ).toBeNull();
    const model = settings();
    model.modelVersion = '';
    await expect(
      storeObservedCompetitionBacktest('PD', 2026, window, model),
    ).rejects.toThrow(new RangeError('invalid backtest model settings'));
  });
});
