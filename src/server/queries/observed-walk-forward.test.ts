import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cacheLife, cacheTag } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompetitionCode } from '@/lib/config/competitions';
import { strengthModelOptions } from '@/lib/config/model-strengths';
import { halfPoissonDeviance } from '@/lib/model/poisson';
import { MATCH_STATUSES } from '@/lib/types/football';

import * as schema from '../db/schema';
import {
  getCompetitionStrengthValidation,
  type StrengthValidationCandidate,
} from './strengths';

const state = vi.hoisted(() => ({
  database: null as PgliteDatabase<typeof schema> | null,
  queryCount: 0,
  failReads: false,
  failQueryAt: undefined as number | undefined,
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
    return Object.assign(state.database, {
      batch(queries: PromiseLike<unknown>[]) {
        return Promise.all(queries);
      },
    });
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
let window: { from: Date; until: Date; resultsBefore: Date };

function observation(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  return {
    matchId: 100,
    competitionId: 2014,
    season: 2026,
    matchday: 1,
    stage: 'REGULAR_SEASON',
    utcDate: new Date('2026-11-05T12:00:00Z'),
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
    lastUpdated: new Date('2026-11-05T14:00:00Z'),
    observedAt: new Date('2026-11-05T15:00:00Z'),
    source: 'change',
    ...overrides,
  };
}

function prematch(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  return observation({
    matchId: 110,
    status: 'TIMED',
    utcDate: new Date('2026-11-12T12:00:00Z'),
    observedAt: new Date('2026-11-10T00:00:00Z'),
    lastUpdated: new Date('2026-11-10T00:00:00Z'),
    homeGoals: null,
    awayGoals: null,
    homeGoals90: null,
    awayGoals90: null,
    ...overrides,
  });
}

function outcome(overrides: Partial<ObservationInsert> = {}): ObservationInsert {
  return prematch({
    status: 'FINISHED',
    observedAt: new Date('2026-11-12T15:00:00Z'),
    lastUpdated: new Date('2026-11-12T14:00:00Z'),
    homeGoals: 1,
    awayGoals: 0,
    homeGoals90: 1,
    awayGoals90: 0,
    ...overrides,
  });
}

function training(): ObservationInsert[] {
  return [
    observation(),
    observation({
      matchId: 101,
      utcDate: new Date('2026-11-06T12:00:00Z'),
      lastUpdated: new Date('2026-11-06T14:00:00Z'),
      observedAt: new Date('2026-11-06T15:00:00Z'),
    }),
  ];
}

async function saveObservations(...records: ObservationInsert[]) {
  await database.insert(schema.matchObservations).values(records);
}

async function sample() {
  await saveObservations(...training(), prematch(), outcome());
}

function validate(
  candidates: readonly StrengthValidationCandidate[] = [{ id: 'base', options }],
) {
  return getCompetitionStrengthValidation(
    'PD',
    2026,
    window,
    candidates,
    'observed',
  );
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, {
    schema,
    casing: 'snake_case',
    logger: {
      logQuery() {
        state.queryCount++;
        if (state.queryCount === state.failQueryAt)
          throw new Error('postgresql://user:private-token@database.example');
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
  state.failQueryAt = undefined;
  state.beforeDatabaseAccess = undefined;
  window = {
    from: new Date('2026-11-11T00:00:00Z'),
    until: new Date('2026-11-13T00:00:00Z'),
    resultsBefore: new Date('2026-11-16T00:00:00Z'),
  };
  await client.exec(`
    TRUNCATE competitions, teams RESTART IDENTITY CASCADE;
    INSERT INTO competitions (id, code, name) VALUES
      (2014, 'PD', 'La Liga'), (2021, 'PL', 'Premier League'),
      (2016, 'ELC', 'Championship'), (2001, 'CL', 'Champions League');
    INSERT INTO teams (id, name, short_name, tla) VALUES
      (1, 'One', 'One', 'ONE'), (2, 'Two', 'Two', 'TWO'),
      (3, 'Three', 'Three', 'THR'), (4, 'Four', 'Four', 'FOU');
    INSERT INTO team_competitions (competition_id, season, team_id) VALUES
      (2014, 2026, 3), (2014, 2026, 4);
  `);
  await database.insert(schema.matches).values(
    Array.from({ length: 46 }, (_value, index) => ({
      id: 100 + index,
      competitionId: 2014,
      season: 2026,
      stage: 'REGULAR_SEASON',
      status: 'FINISHED' as const,
      utcDate: new Date('2026-11-15T12:00:00Z'),
      lastUpdated: new Date('2026-11-15T15:00:00Z'),
      homeTeamId: 3,
      awayTeamId: 4,
      homeGoals90: 99,
      awayGoals90: 99,
      duration: 'REGULAR' as const,
    })),
  );
  await database.delete(schema.matchObservations);
  state.queryCount = 0;
});

describe('observed walk-forward strength validation', () => {
  it('replays a known prematch fixture through the normal validation entry point', async () => {
    await sample();
    state.queryCount = 0;
    const result = await validate();
    expect(result).toMatchObject({
      competitionCode: 'PD',
      season: 2026,
      previousSeason: 2025,
      window,
      resultAvailability: { mode: 'observed', delayHours: null },
      matchCount: 1,
      commonMatchIds: [110],
    });
    expect(result?.candidates[0]).toMatchObject({
      id: 'base',
      options,
      forecastCount: 1,
      lowDataCount: 0,
      common: { matchCount: 1, forecastCount: 1, lowDataCount: 0 },
    });
    expect(result?.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
      halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1),
      12,
    );
    expect(state.queryCount).toBe(2);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it('returns an empty evaluation before result observations were collected', async () => {
    const result = await validate();
    expect(result).toMatchObject({
      matchCount: 0,
      commonMatchIds: [],
      candidates: [
        {
          id: 'base',
          forecastCount: 0,
          common: { matchCount: 0, meanPoissonDeviance: null },
        },
      ],
    });
  });

  it('counts a known result with an unavailable historical prematch fixture', async () => {
    await saveObservations(...training(), outcome());
    const result = await validate();
    expect(result).toMatchObject({
      matchCount: 1,
      commonMatchIds: [],
      candidates: [{ forecastCount: 0, common: { meanPoissonDeviance: null } }],
    });
  });

  it.each(MATCH_STATUSES)(
    'checks the recorded %s fixture status at kickoff',
    async (status) => {
      await saveObservations(...training(), prematch({ status }), outcome());
      const result = await validate();
      expect(result?.matchCount).toBe(1);
      expect(result?.candidates[0]?.forecastCount).toBe(
        status === 'SCHEDULED' || status === 'TIMED' ? 1 : 0,
      );
    },
  );

  it.each([-1, 0, 1])(
    'checks a prematch observation at kickoff offset %s milliseconds',
    async (offset) => {
      await saveObservations(
        ...training(),
        prematch({
          observedAt: new Date(new Date('2026-11-12T12:00:00Z').getTime() + offset),
        }),
        outcome(),
      );
      expect((await validate())?.candidates[0]?.forecastCount).toBe(
        offset < 0 ? 1 : 0,
      );
    },
  );

  it.each([
    { homeTeamId: null },
    { awayTeamId: null },
    { homeTeamId: 1, awayTeamId: 1 },
  ])('requires known, distinct historical opponents %j', async (changes) => {
    await saveObservations(...training(), prematch(changes), outcome());
    expect((await validate())?.candidates[0]?.forecastCount).toBe(0);
  });

  it.each([{ homeTeamId: 3 }, { awayTeamId: 3 }])(
    'requires the observed opponents to match the evaluated fixture %j',
    async (changes) => {
      await saveObservations(
        ...training(),
        observation({ matchId: 102, ...changes }),
        observation({ matchId: 103, ...changes }),
        prematch(),
        outcome(changes),
      );
      expect((await validate())?.candidates[0]?.forecastCount).toBe(0);
    },
  );

  it.each([1, 3_600_000])(
    'requires the observed kickoff to match the evaluated fixture at offset %s',
    async (offset) => {
      await saveObservations(
        ...training(),
        prematch({
          utcDate: new Date(new Date('2026-11-12T12:00:00Z').getTime() + offset),
        }),
        outcome(),
      );
      expect((await validate())?.candidates[0]?.forecastCount).toBe(0);
    },
  );

  it.each([{ stage: 'LAST_16' }, { season: 2025 }, { competitionId: 2021 }])(
    'requires the historical fixture scope to match evaluation %j',
    async (changes) => {
      await saveObservations(...training(), prematch(changes), outcome());
      expect((await validate())?.candidates[0]?.forecastCount).toBe(0);
    },
  );

  it('replays a rescheduled match at the newly observed kickoff', async () => {
    const kickoff = new Date('2026-11-14T12:00:00Z');
    await saveObservations(
      ...training(),
      prematch(),
      prematch({
        status: 'POSTPONED',
        observedAt: new Date('2026-11-11T00:00:00Z'),
      }),
      prematch({ utcDate: kickoff, observedAt: new Date('2026-11-13T00:00:00Z') }),
      outcome({ utcDate: kickoff, observedAt: new Date('2026-11-14T15:00:00Z') }),
    );
    window.until = new Date('2026-11-15T00:00:00Z');
    expect(await validate()).toMatchObject({
      matchCount: 1,
      commonMatchIds: [110],
      candidates: [{ forecastCount: 1 }],
    });
  });

  it('counts a reschedule learned after its new kickoff as unavailable', async () => {
    const kickoff = new Date('2026-11-14T12:00:00Z');
    await saveObservations(
      ...training(),
      prematch({ status: 'POSTPONED' }),
      prematch({ utcDate: kickoff, observedAt: new Date(kickoff.getTime() + 1) }),
      outcome({ utcDate: kickoff, observedAt: new Date('2026-11-14T15:00:00Z') }),
    );
    window.until = new Date('2026-11-15T00:00:00Z');
    expect(await validate()).toMatchObject({
      matchCount: 1,
      commonMatchIds: [],
      candidates: [{ forecastCount: 0 }],
    });
  });

  it('rewinds late training corrections to the version known at kickoff', async () => {
    await sample();
    await saveObservations(
      observation({
        homeGoals90: 9,
        awayGoals90: 9,
        observedAt: new Date('2026-11-13T00:00:00Z'),
      }),
    );
    const result = await validate();
    expect(result?.candidates[0]?.forecastCount).toBe(1);
    expect(result?.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
      halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1),
      12,
    );
  });

  it('scores the result version observed before resultsBefore', async () => {
    await sample();
    await saveObservations(
      outcome({
        homeGoals90: 3,
        awayGoals90: 2,
        observedAt: new Date('2026-11-15T00:00:00Z'),
      }),
    );
    const earlier = await getCompetitionStrengthValidation(
      'PD',
      2026,
      { ...window, resultsBefore: new Date('2026-11-14T00:00:00Z') },
      [{ id: 'base', options }],
      'observed',
    );
    const later = await validate();
    expect(earlier?.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
      halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1),
      12,
    );
    expect(later?.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
      halfPoissonDeviance(3, 2) + halfPoissonDeviance(2, 1),
      12,
    );
  });

  it.each([-1, 0, 1])(
    'checks result observation at evaluation offset %s milliseconds',
    async (offset) => {
      await saveObservations(
        ...training(),
        prematch(),
        outcome({ observedAt: new Date(window.resultsBefore.getTime() + offset) }),
      );
      expect((await validate())?.matchCount).toBe(offset < 0 ? 1 : 0);
    },
  );

  it('applies the half-open fixture window', async () => {
    await saveObservations(...training(), prematch(), outcome());
    window.from = new Date('2026-11-12T12:00:00Z');
    expect((await validate())?.matchCount).toBe(1);
    window.from = new Date(window.from.getTime() + 1);
    expect((await validate())?.matchCount).toBe(0);
    window.from = new Date('2026-11-11T00:00:00Z');
    window.until = new Date('2026-11-12T12:00:00Z');
    expect((await validate())?.matchCount).toBe(0);
  });

  it.each(['CANCELLED', 'POSTPONED', 'AWARDED'] as const)(
    'evaluates only results still finished at resultsBefore after %s',
    async (status) => {
      await sample();
      await saveObservations(
        outcome({ status, observedAt: new Date('2026-11-15T00:00:00Z') }),
      );
      expect((await validate())?.matchCount).toBe(0);
    },
  );

  it('uses the 90-minute score for evaluation', async () => {
    await saveObservations(
      ...training(),
      prematch(),
      outcome({
        homeGoals: 3,
        awayGoals: 3,
        homeGoals90: 1,
        awayGoals90: 1,
        duration: 'PENALTY_SHOOTOUT',
        homePenalties: 5,
        awayPenalties: 4,
      }),
    );
    expect(
      (await validate())?.candidates[0]?.common.meanPoissonDeviance,
    ).toBeCloseTo(halfPoissonDeviance(1, 2) + halfPoissonDeviance(1, 1), 12);
  });

  it('returns an empty evaluation for incomplete 90-minute results', async () => {
    await saveObservations(
      ...training(),
      prematch(),
      outcome({ homeGoals90: null }),
    );
    expect((await validate())?.matchCount).toBe(0);
  });

  it('shares kickoff inputs across candidates and simultaneous fixtures', async () => {
    await sample();
    await saveObservations(prematch({ matchId: 111 }), outcome({ matchId: 111 }));
    state.queryCount = 0;
    const result = await validate([
      { id: 'base', options },
      { id: 'other', options: { ...options, priorMatchCount: 1 } },
    ]);
    expect(result?.commonMatchIds).toEqual([110, 111]);
    expect(result?.candidates.map((candidate) => candidate.forecastCount)).toEqual([
      2, 2,
    ]);
    expect(state.queryCount).toBe(2);
  });

  it('tracks unavailable candidate forecasts on the common evaluation set', async () => {
    await sample();
    const result = await validate([
      { id: 'base', options },
      { id: 'strict', options: { ...options, minEffectiveMatchCount: 3 } },
    ]);
    expect(result?.matchCount).toBe(1);
    expect(result?.commonMatchIds).toEqual([]);
    expect(result?.candidates.map((candidate) => candidate.forecastCount)).toEqual([
      1, 0,
    ]);
    expect(
      result?.candidates.map((candidate) => candidate.common.matchCount),
    ).toEqual([0, 0]);
  });

  it('uses an earlier validation result only after it was observed before a later kickoff', async () => {
    await sample();
    const nextKickoff = new Date('2026-11-13T12:00:00Z');
    await saveObservations(
      prematch({ matchId: 111, utcDate: nextKickoff }),
      outcome({
        matchId: 111,
        utcDate: nextKickoff,
        observedAt: new Date('2026-11-13T15:00:00Z'),
      }),
    );
    window.until = new Date('2026-11-14T00:00:00Z');
    const result = await validate();
    expect(result?.commonMatchIds).toEqual([110, 111]);
    expect(result?.candidates[0]?.common.meanPoissonDeviance).not.toBeCloseTo(
      halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1),
      8,
    );
  });

  it('keeps results received at a simultaneous cutoff outside its training sample', async () => {
    const nextKickoff = new Date('2026-11-13T12:00:00Z');
    await saveObservations(
      ...training(),
      prematch(),
      outcome({ observedAt: nextKickoff }),
      prematch({ matchId: 111, utcDate: nextKickoff }),
      outcome({
        matchId: 111,
        utcDate: nextKickoff,
        observedAt: new Date('2026-11-13T15:00:00Z'),
      }),
    );
    window.until = new Date('2026-11-14T00:00:00Z');
    expect(
      (await validate())?.candidates[0]?.common.meanPoissonDeviance,
    ).toBeCloseTo(halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1), 12);
  });

  it.each([
    { code: 'PD' as CompetitionCode, id: 2014, stage: 'REGULAR_SEASON' },
    { code: 'PL' as CompetitionCode, id: 2021, stage: 'REGULAR_SEASON' },
    { code: 'CL' as CompetitionCode, id: 2001, stage: 'LEAGUE_STAGE' },
  ])(
    'scopes the observed mode for $code main stages',
    async ({ code, id, stage }) => {
      await saveObservations(
        ...training().map((row) => ({ ...row, competitionId: id, stage })),
        prematch({ competitionId: id, stage }),
        outcome({ competitionId: id, stage }),
      );
      const result = await getCompetitionStrengthValidation(
        code,
        2026,
        window,
        [{ id: 'base', options }],
        'observed',
      );
      expect(result?.commonMatchIds).toEqual([110]);
      expect(result?.candidates[0]?.forecastCount).toBe(1);
    },
  );

  it('evaluates the configured main stage', async () => {
    await saveObservations(
      ...training(),
      prematch({ stage: 'LAST_16' }),
      outcome({ stage: 'LAST_16' }),
    );
    expect((await validate())?.matchCount).toBe(0);
  });

  it('captures candidate settings and the caller window before loading data', async () => {
    await sample();
    const settings = [{ id: 'original', options: { ...options } }];
    const expectedWindow = {
      from: new Date(window.from),
      until: new Date(window.until),
      resultsBefore: new Date(window.resultsBefore),
    };
    state.beforeDatabaseAccess = () => {
      window.from.setTime(0);
      window.until.setTime(0);
      window.resultsBefore.setTime(0);
      settings[0]!.id = 'changed';
      settings[0]!.options.minEffectiveMatchCount = 0;
    };
    const result = await validate(settings);
    expect(result?.window).toEqual(expectedWindow);
    expect(result?.candidates[0]).toMatchObject({
      id: 'original',
      forecastCount: 1,
      options,
    });
  });

  it('reads new historical evidence on a subsequent validation invocation', async () => {
    await sample();
    const first = await validate();
    await saveObservations(observation({ matchId: 102, homeGoals90: 8 }));
    const second = await validate();
    expect(second?.candidates[0]?.common.meanPoissonDeviance).not.toBeCloseTo(
      first?.candidates[0]?.common.meanPoissonDeviance ?? NaN,
      8,
    );
  });

  it.each(['from', 'until', 'resultsBefore'] as const)(
    'rejects an invalid %s',
    async (field) => {
      window[field] = new Date(NaN);
      await expect(validate()).rejects.toThrow(RangeError);
    },
  );

  it('rejects a reversed or empty fixture window', async () => {
    window.until = new Date(window.from);
    await expect(validate()).rejects.toThrow(RangeError);
  });

  it('validates the candidate set before database access', async () => {
    state.failReads = true;
    await expect(validate([])).rejects.toThrow(
      'at least one strength validation candidate is required',
    );
    await expect(
      validate([
        { id: 'same', options },
        { id: 'same', options },
      ]),
    ).rejects.toThrow('forecast candidate IDs must be unique');
    await expect(
      getCompetitionStrengthValidation(
        'PD',
        2026,
        window,
        [{ id: 'base', options }],
        'other' as never,
      ),
    ).rejects.toThrow('unsupported result availability mode');
  });

  it('returns null for an unconfigured season before reading the database', async () => {
    state.failReads = true;
    expect(
      await getCompetitionStrengthValidation(
        'PD',
        2022,
        window,
        [{ id: 'base', options }],
        'observed',
      ),
    ).toBeNull();
  });

  it.each([1, 2])(
    'propagates a sanitized failure at SQL statement %s and supports retry',
    async (failure) => {
      await sample();
      state.queryCount = 0;
      state.failQueryAt = failure;
      const result = validate();
      await expect(result).rejects.toThrow(
        new Error('competition match observations could not be loaded'),
      );
      await expect(result).rejects.not.toHaveProperty('cause');
      state.failQueryAt = undefined;
      state.queryCount = 0;
      expect((await validate())?.candidates[0]?.forecastCount).toBe(1);
    },
  );
});

describe('current-record strength validation compatibility', () => {
  it.each([undefined, 'api-update', 'reconstructed'] as const)(
    'runs the %s availability entry point',
    async (availability) => {
      await client.exec('TRUNCATE matches RESTART IDENTITY CASCADE;');
      const common = {
        competitionId: 2014,
        season: 2026,
        stage: 'REGULAR_SEASON',
        status: 'FINISHED' as const,
        homeTeamId: 1,
        awayTeamId: 2,
        homeGoals90: 2,
        awayGoals90: 1,
        duration: 'REGULAR' as const,
      };
      await database.insert(schema.matches).values([
        {
          ...common,
          id: 100,
          utcDate: new Date('2026-11-05T12:00:00Z'),
          lastUpdated: new Date('2026-11-05T15:00:00Z'),
        },
        {
          ...common,
          id: 101,
          utcDate: new Date('2026-11-06T12:00:00Z'),
          lastUpdated: new Date('2026-11-06T15:00:00Z'),
        },
        {
          ...common,
          id: 110,
          utcDate: new Date('2026-11-12T12:00:00Z'),
          lastUpdated: new Date('2026-11-12T15:00:00Z'),
          homeGoals90: 1,
          awayGoals90: 0,
        },
      ]);
      await database.insert(schema.teamCompetitions).values([
        { competitionId: 2014, season: 2026, teamId: 1 },
        { competitionId: 2014, season: 2026, teamId: 2 },
      ]);
      const result = await getCompetitionStrengthValidation(
        'PD',
        2026,
        window,
        [{ id: 'base', options }],
        availability,
      );
      expect(result?.commonMatchIds).toEqual([110]);
      expect(result?.resultAvailability).toEqual({
        mode: availability ?? 'api-update',
        delayHours: availability === 'reconstructed' ? 24 : null,
      });
      expect(result?.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
        halfPoissonDeviance(1, 2) + halfPoissonDeviance(0, 1),
        12,
      );
    },
  );
});
