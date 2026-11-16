import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MATCH_STATUSES } from '@/lib/types/football';

import * as schema from '../db/schema';
import { loadCompetitionMatchObservations } from './match-observations';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  failReads: false,
  queryCount: 0,
  beforeDatabaseAccess: undefined as (() => void) | undefined,
}));

vi.mock('server-only', () => ({}));
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
let client: PGlite;
let database: PgliteDatabase<typeof schema>;
let before: Date;

function observation(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  return {
    matchId: 100,
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
    lastUpdated: new Date('2026-11-07T12:00:00Z'),
    observedAt: new Date('2026-11-08T12:00:00Z'),
    source: 'change',
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
  state.failReads = false;
  state.beforeDatabaseAccess = undefined;
  before = new Date('2026-11-08T13:00:00Z');
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES
      (2021, 'PL', 'Premier League'), (2001, 'CL', 'Champions League'),
      (2016, 'ELC', 'Championship');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (57, 'Arsenal', 'Arsenal', 'ARS'), (61, 'Chelsea', 'Chelsea', 'CHE'),
      (62, 'Everton', 'Everton', 'EVE');
  `);
  await database.insert(schema.matches).values(
    [100, 101, 102, 103].map((id) => ({
      id,
      competitionId: 2021,
      season: 2026,
      stage: 'REGULAR_SEASON',
      utcDate: new Date('2026-11-09T20:00:00Z'),
      status: 'FINISHED' as const,
      homeTeamId: 62,
      awayTeamId: 61,
      homeGoals: 9,
      awayGoals: 9,
      homeGoals90: 9,
      awayGoals90: 9,
      duration: 'REGULAR' as const,
      lastUpdated: new Date('2026-11-10T12:00:00Z'),
    })),
  );
  // Individual tests provide historical observations for their chosen cutoff.
  await database.delete(schema.matchObservations);
  state.queryCount = 0;
});

describe('observed competition match lookup', () => {
  it('returns the complete observed state for the requested historical scope', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values(observation())
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual(
      saved,
    );
  });

  it('returns an empty history when only a current match record exists', async () => {
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([]);
  });

  it('returns an empty history for an absent competition or season', async () => {
    await database.insert(schema.matchObservations).values(observation());
    expect(await loadCompetitionMatchObservations('PD', [2026], before)).toEqual([]);
    expect(await loadCompetitionMatchObservations('PL', [2024], before)).toEqual([]);
  });

  it('uses an exclusive observation cutoff', async () => {
    await database.insert(schema.matchObservations).values([
      observation({
        matchId: 100,
        observedAt: new Date('2026-11-08T12:59:59.999Z'),
      }),
      observation({ matchId: 101, observedAt: new Date(before) }),
      observation({ matchId: 102, observedAt: new Date(before.getTime() + 1) }),
    ]);
    expect(
      (await loadCompetitionMatchObservations('PL', [2026], before)).map(
        (row) => row.matchId,
      ),
    ).toEqual([100]);
  });

  it('keeps the previous version when a correction is received at the cutoff', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation(),
        observation({ homeGoals90: 3, observedAt: new Date(before) }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[0],
    ]);
  });

  it('reveals late corrections only after their observation time', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation(),
        observation({
          homeGoals: 3,
          homeGoals90: 3,
          observedAt: new Date('2026-11-08T14:00:00Z'),
        }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[0],
    ]);
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T15:00:00Z'),
      ),
    ).toEqual([saved[1]]);
  });

  it('orders versions by receipt time when API timestamps are out of order', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation({ lastUpdated: new Date('2100-01-01T00:00:00Z') }),
        observation({
          homeGoals90: 3,
          observedAt: new Date('2026-11-08T12:30:00Z'),
          lastUpdated: new Date('2026-11-07T00:00:00Z'),
        }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[1],
    ]);
  });

  it('uses row ID to resolve equal observation times', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([observation({ source: 'baseline' }), observation({ homeGoals90: 3 })])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[1],
    ]);
  });

  it('compares PostgreSQL microseconds before decoding timestamps into JavaScript dates', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        {
          ...observation({ homeGoals90: 3 }),
          observedAt: sql`'2026-11-08T12:00:00.000900+00'::timestamptz`,
        },
        {
          ...observation({ homeGoals90: 1 }),
          observedAt: sql`'2026-11-08T12:00:00.000100+00'::timestamptz`,
        },
      ])
      .returning();
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T12:00:00.001Z'),
      ),
    ).toEqual([saved[0]]);
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T12:00:00.000Z'),
      ),
    ).toEqual([]);
  });

  it.each(MATCH_STATUSES)(
    'returns the latest %s state after a finished state',
    async (status) => {
      const saved = await database
        .insert(schema.matchObservations)
        .values([
          observation(),
          observation({ status, observedAt: new Date('2026-11-08T12:30:00Z') }),
        ])
        .returning();
      expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
        saved[1],
      ]);
    },
  );

  it.each([
    {
      field: 'competition',
      changes: { competitionId: 2001 },
      destinationCode: 'CL' as const,
      destinationSeasons: [2026],
    },
    {
      field: 'season',
      changes: { season: 2025 },
      destinationCode: 'PL' as const,
      destinationSeasons: [2025],
    },
  ])(
    'applies a change of $field after selecting the latest match state',
    async ({ changes, destinationCode, destinationSeasons }) => {
      const [initial] = await database
        .insert(schema.matchObservations)
        .values(observation())
        .returning();
      await database
        .update(schema.matches)
        .set(changes)
        .where(eq(schema.matches.id, 100));
      const updated = await database
        .insert(schema.matchObservations)
        .values(
          observation({ ...changes, observedAt: new Date('2026-11-08T12:30:00Z') }),
        )
        .returning();
      expect(
        await loadCompetitionMatchObservations(
          'PL',
          [2026],
          new Date('2026-11-08T12:15:00Z'),
        ),
      ).toEqual([initial]);
      expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual(
        [],
      );
      expect(
        await loadCompetitionMatchObservations(
          destinationCode,
          destinationSeasons,
          before,
        ),
      ).toEqual(updated);
    },
  );

  it('reveals a match entering the requested competition at its observation time', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation({ competitionId: 2001 }),
        observation({ observedAt: new Date('2026-11-08T12:30:00Z') }),
      ])
      .returning();
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T12:15:00Z'),
      ),
    ).toEqual([]);
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[1],
    ]);
  });

  it('returns one latest state across multiple and repeated requested seasons', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation(),
        observation({ season: 2025, observedAt: new Date('2026-11-08T12:30:00Z') }),
        observation({ matchId: 101 }),
      ])
      .returning();
    expect(
      await loadCompetitionMatchObservations('PL', [2025, 2026, 2025], before),
    ).toEqual([saved[1], saved[2]]);
  });

  it('keeps other competitions and seasons outside the requested scope', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation(),
        observation({ matchId: 101, competitionId: 2001 }),
        observation({ matchId: 102, season: 2025 }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[0],
    ]);
  });

  it('supports ELC observations used by promoted-team history', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values(observation({ competitionId: 2016, season: 2025 }))
      .returning();
    expect(await loadCompetitionMatchObservations('ELC', [2025], before)).toEqual(
      saved,
    );
  });

  it.each([
    ['stage', { stage: 'LAST_16' }],
    [
      'kickoff and round',
      { utcDate: new Date('2026-11-13T20:00:00Z'), matchday: null },
    ],
    [
      'participants and scores',
      {
        homeTeamId: 62,
        awayTeamId: null,
        homeGoals: null,
        awayGoals: null,
        homeGoals90: null,
        awayGoals90: null,
      },
    ],
    [
      'extra time and penalties',
      {
        duration: 'PENALTY_SHOOTOUT' as const,
        homeGoals: 3,
        awayGoals: 3,
        homeGoals90: 1,
        awayGoals90: 1,
        homePenalties: 5,
        awayPenalties: 4,
      },
    ],
  ])('retains the observed %s fields', async (_name, changes) => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation(),
        observation({ ...changes, observedAt: new Date('2026-11-08T12:30:00Z') }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[1],
    ]);
  });

  it('makes baseline data available from collection start', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values(observation({ source: 'baseline' }))
      .returning();
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T11:59:59.999Z'),
      ),
    ).toEqual([]);
    expect(
      await loadCompetitionMatchObservations(
        'PL',
        [2026],
        new Date('2026-11-08T12:00:00.001Z'),
      ),
    ).toEqual(saved);
  });

  it('orders returned fixtures by observed kickoff and match ID', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values([
        observation({ utcDate: new Date('2026-11-07T20:00:00Z') }),
        observation({ matchId: 102 }),
        observation({ matchId: 101 }),
      ])
      .returning();
    expect(await loadCompetitionMatchObservations('PL', [2026], before)).toEqual([
      saved[2],
      saved[1],
      saved[0],
    ]);
  });

  it('reads the complete historical selection in one SQL statement', async () => {
    await database.insert(schema.matchObservations).values(observation());
    state.queryCount = 0;
    expect(
      await loadCompetitionMatchObservations('PL', [2026], before),
    ).toHaveLength(1);
    expect(state.queryCount).toBe(1);
  });

  it('captures the caller cutoff and season array before accessing the database', async () => {
    const saved = await database
      .insert(schema.matchObservations)
      .values(observation())
      .returning();
    const seasons = [2026];
    state.beforeDatabaseAccess = () => {
      before.setTime(new Date('2020-01-01T00:00:00Z').getTime());
      seasons.splice(0, seasons.length, 2025);
    };
    expect(await loadCompetitionMatchObservations('PL', seasons, before)).toEqual(
      saved,
    );
  });

  it.each([-2147483648, 0, 2147483647])(
    'supports stored integer season %s',
    async (season) => {
      const saved = await database
        .insert(schema.matchObservations)
        .values(observation({ season }))
        .returning();
      expect(await loadCompetitionMatchObservations('PL', [season], before)).toEqual(
        saved,
      );
    },
  );

  it('reports database failures with a sanitized error', async () => {
    state.failReads = true;
    const result = loadCompetitionMatchObservations('PL', [2026], before);
    await expect(result).rejects.toThrow(
      new Error('competition match observations could not be loaded'),
    );
    await expect(result).rejects.not.toHaveProperty('cause');
  });

  const validDate = new Date('2026-11-08T13:00:00Z');
  const invalidLookups: [string, unknown[]][] = [
    ['unsupported competition', ['XYZ', [2026], validDate]],
    ['lowercase competition', ['pl', [2026], validDate]],
    ['missing competition', [null, [2026], validDate]],
    ['inherited object key', ['constructor', [2026], validDate]],
    ['empty seasons', ['PL', [], validDate]],
    ['missing seasons', ['PL', null, validDate]],
    ['fractional season', ['PL', [2026.5], validDate]],
    ['NaN season', ['PL', [Number.NaN], validDate]],
    ['infinite season', ['PL', [Number.POSITIVE_INFINITY], validDate]],
    ['season above int32', ['PL', [2147483648], validDate]],
    ['season below int32', ['PL', [-2147483649], validDate]],
    ['string season', ['PL', ['2026'], validDate]],
    ['invalid cutoff', ['PL', [2026], new Date(Number.NaN)]],
    ['string cutoff', ['PL', [2026], validDate.toISOString()]],
    ['missing cutoff', ['PL', [2026], undefined]],
    ['null cutoff', ['PL', [2026], null]],
  ];
  it.each(invalidLookups)(
    'rejects %s before accessing the database',
    async (_name, args) => {
      state.failReads = true;
      await expect(
        loadCompetitionMatchObservations(
          ...(args as unknown as Parameters<
            typeof loadCompetitionMatchObservations
          >),
        ),
      ).rejects.toThrow(new RangeError('invalid match observation lookup'));
      expect(state.queryCount).toBe(0);
    },
  );
});
