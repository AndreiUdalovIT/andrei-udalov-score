import { describe, expect, it } from 'vitest';

import { createPoissonScoreSampler } from './poisson-score-sampler';
import { createSeededRandom } from './seeded-random';
import {
  createSeasonCalendarSampler,
  SEASON_CALENDAR_SAMPLING_ALGORITHM,
  type SeasonCalendarFixture,
} from './season-calendar-sampler';

const options = Object.freeze({ tailTolerance: 1e-10, maxGoals: 64 });

const fixtures = Object.freeze([
  Object.freeze({
    id: 30,
    homeTeamId: 2,
    awayTeamId: 3,
    kind: 'forecast',
    homeRate90: 1.5,
    awayRate90: 0.8,
  } as const),
  Object.freeze({
    id: 20,
    homeTeamId: 1,
    awayTeamId: 3,
    kind: 'known-result',
    homeGoals90: 2,
    awayGoals90: 1,
  } as const),
  Object.freeze({
    id: 10,
    homeTeamId: 1,
    awayTeamId: 2,
    kind: 'forecast',
    homeRate90: 0.8,
    awayRate90: 1.5,
  } as const),
] as const);

function randomFrom(values: readonly number[]) {
  let calls = 0;
  return { random: () => values[calls++]!, calls: () => calls };
}

describe('one reproducible season calendar sample', () => {
  it('keeps known results and assigns draws in ascending fixture ID order', () => {
    const sampler = createSeasonCalendarSampler(fixtures, options)!;
    const random = randomFrom([0.9, 0.5, 0.05, 0.9]);
    expect(sampler.sample(random.random)).toEqual([
      {
        id: 10,
        homeTeamId: 1,
        awayTeamId: 2,
        source: 'simulated',
        homeGoals90: 2,
        awayGoals90: 1,
      },
      {
        id: 20,
        homeTeamId: 1,
        awayTeamId: 3,
        source: 'known-result',
        homeGoals90: 2,
        awayGoals90: 1,
      },
      {
        id: 30,
        homeTeamId: 2,
        awayTeamId: 3,
        source: 'simulated',
        homeGoals90: 0,
        awayGoals90: 2,
      },
    ]);
    expect(random.calls()).toBe(4);
    expect(sampler.algorithm).toBe(SEASON_CALENDAR_SAMPLING_ALGORITHM);
    expect(sampler.algorithm).toBe('fixture-id-ordered-poisson-calendar-v1');
    expect(sampler.scoreSamplingAlgorithm).toBe(
      'independent-poisson-conditioned-cdf-v1',
    );
    expect(sampler.fixedFixtureCount).toBe(1);
    expect(sampler.simulatedFixtureCount).toBe(2);
    expect(fixtures.map(({ id }) => id)).toEqual([30, 20, 10]);
  });

  it('reproduces both scores and metadata for every permutation of the inputs', () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const input = [
      fixtures[0]!,
      fixtures[2]!,
      { ...fixtures[0]!, id: 40, homeRate90: 2.64, awayRate90: 10 },
    ];
    const baseline = createSeasonCalendarSampler(input, options)!;
    const firstRandom = createSeededRandom([123, 456, 789, 101112]);
    const expected = Array.from({ length: 100 }, () => baseline.sample(firstRandom));
    for (const order of orders) {
      const sampler = createSeasonCalendarSampler(
        order.map((index) => input[index]!),
        options,
      )!;
      const random = createSeededRandom([123, 456, 789, 101112]);
      expect(Array.from({ length: 100 }, () => sampler.sample(random))).toEqual(
        expected,
      );
      expect(sampler.tailUpperBound).toBe(baseline.tailUpperBound);
    }
  });

  it('sums the score tail bounds for one run and excludes fixed results', () => {
    const sampler = createSeasonCalendarSampler(fixtures, options)!;
    const first = createPoissonScoreSampler(0.8, 1.5, options)!;
    const second = createPoissonScoreSampler(1.5, 0.8, options)!;
    expect(sampler.tailUpperBound).toBe(
      first.tailUpperBound + second.tailUpperBound,
    );
    expect(sampler.tailUpperBound).toBeGreaterThan(0);
    expect(sampler.tailUpperBound).toBeLessThanOrEqual(2 * options.tailTolerance);
  });

  it('caps a union bound at one for loose per-score tolerances', () => {
    const sampler = createSeasonCalendarSampler(
      Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        homeTeamId: 1,
        awayTeamId: 2,
        kind: 'forecast' as const,
        homeRate90: 0.5,
        awayRate90: 0,
      })),
      { tailTolerance: 0.9, maxGoals: 1 },
    )!;
    expect(sampler.tailUpperBound).toBe(1);
  });

  it('accepts an empty calendar without drawing random values', () => {
    const sampler = createSeasonCalendarSampler([], options)!;
    const random = randomFrom([]);
    expect(sampler.sample(random.random)).toEqual([]);
    expect(sampler.fixedFixtureCount).toBe(0);
    expect(sampler.simulatedFixtureCount).toBe(0);
    expect(sampler.tailUpperBound).toBe(0);
    expect(random.calls()).toBe(0);
  });

  it('preserves a fully completed calendar without drawing random values', () => {
    const sampler = createSeasonCalendarSampler([fixtures[1]!], options)!;
    const random = randomFrom([]);
    expect(sampler.sample(random.random)[0]).toMatchObject({
      id: 20,
      source: 'known-result',
      homeGoals90: 2,
      awayGoals90: 1,
    });
    expect(sampler.fixedFixtureCount).toBe(1);
    expect(sampler.simulatedFixtureCount).toBe(0);
    expect(sampler.tailUpperBound).toBe(0);
    expect(random.calls()).toBe(0);
  });

  it('consumes two draws for zero-rate forecasts even beside known results', () => {
    const sampler = createSeasonCalendarSampler(
      [fixtures[1]!, { ...fixtures[0]!, homeRate90: 0, awayRate90: 0 }],
      options,
    )!;
    const random = randomFrom([0, 1 - 2 ** -53]);
    expect(sampler.sample(random.random)[1]).toMatchObject({
      id: 30,
      source: 'simulated',
      homeGoals90: 0,
      awayGoals90: 0,
    });
    expect(random.calls()).toBe(2);
    expect(sampler.tailUpperBound).toBe(0);
  });

  it('copies caller input and returns independent result objects on each run', () => {
    const forecast = { ...fixtures[0]!, id: 30, homeRate90: 1.5 };
    const known = { ...fixtures[1]!, homeGoals90: 2 };
    const input = [forecast, known, fixtures[2]!];
    const sampler = createSeasonCalendarSampler(input, options)!;
    const baseline = sampler.sample(() => 0.5);
    forecast.id = 999;
    forecast.homeRate90 = 0;
    known.homeGoals90 = 999;
    input.splice(1);
    const output = sampler.sample(() => 0.5);
    output[0]!.homeGoals90 = 999;
    output[1]!.awayGoals90 = 999;
    output.reverse();
    expect(sampler.sample(() => 0.5)).toEqual(baseline);
  });

  it('returns null instead of omitting an unavailable forecast', () => {
    expect(
      createSeasonCalendarSampler(
        [...fixtures, { ...fixtures[0]!, id: 40, homeRate90: Number.MAX_VALUE }],
        options,
      ),
    ).toBeNull();
  });

  it('still validates later fixtures after an unavailable forecast', () => {
    const unavailable = { ...fixtures[0]!, id: 1, homeRate90: Number.MAX_VALUE };
    expect(() =>
      createSeasonCalendarSampler(
        [unavailable, { ...fixtures[1]!, homeGoals90: -1 }],
        options,
      ),
    ).toThrow(RangeError);
    expect(() =>
      createSeasonCalendarSampler(
        [unavailable, { ...fixtures[0]!, awayRate90: NaN }],
        options,
      ),
    ).toThrow(RangeError);
  });

  it('rejects duplicate fixture identities, including conflicting participants', () => {
    expect(() =>
      createSeasonCalendarSampler(
        [fixtures[0]!, { ...fixtures[0]!, awayTeamId: 4 }],
        options,
      ),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid ID %s in every identity field',
    (id) => {
      for (const field of ['id', 'homeTeamId', 'awayTeamId'] as const) {
        expect(() =>
          createSeasonCalendarSampler([{ ...fixtures[0]!, [field]: id }], options),
        ).toThrow(RangeError);
      }
    },
  );

  it('rejects a fixture against the same team', () => {
    expect(() =>
      createSeasonCalendarSampler(
        [{ ...fixtures[0]!, awayTeamId: fixtures[0]!.homeTeamId }],
        options,
      ),
    ).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid known score %s for either team',
    (goals) => {
      for (const field of ['homeGoals90', 'awayGoals90'] as const) {
        expect(() =>
          createSeasonCalendarSampler(
            [{ ...fixtures[1]!, [field]: goals }],
            options,
          ),
        ).toThrow(RangeError);
      }
    },
  );

  it('rejects an unclassified fixture rather than inventing its treatment', () => {
    const fixture = {
      ...fixtures[0]!,
      kind: 'pending',
    } as unknown as SeasonCalendarFixture;
    expect(() => createSeasonCalendarSampler([fixture], options)).toThrow(
      RangeError,
    );
  });

  it('validates sampling options for empty and completed calendars', () => {
    for (const input of [[], [fixtures[1]!]]) {
      expect(() =>
        createSeasonCalendarSampler(input, { tailTolerance: 1, maxGoals: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        createSeasonCalendarSampler(input, { tailTolerance: 1e-10, maxGoals: -1 }),
      ).toThrow(RangeError);
    }
  });

  it('propagates an invalid random stream without clamping or replacing it', () => {
    const sampler = createSeasonCalendarSampler(fixtures, options)!;
    expect(() => sampler.sample(() => 1)).toThrow(RangeError);
    expect(() => sampler.sample(() => NaN)).toThrow(RangeError);
  });
});
