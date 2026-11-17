import { describe, expect, it } from 'vitest';

import { poissonProbability } from './poisson';
import { calculatePoissonDistribution } from './poisson-distribution';
import {
  createPoissonScoreSampler,
  POISSON_SCORE_SAMPLING_ALGORITHM,
  type PoissonScoreSampler,
} from './poisson-score-sampler';
import { createSeededRandom } from './seeded-random';

const options = Object.freeze({ tailTolerance: 1e-10, maxGoals: 64 });

function sampleAt(sampler: PoissonScoreSampler, home: number, away: number) {
  const values = [home, away];
  let calls = 0;
  const score = sampler.sample(() => values[calls++]!);
  expect(calls).toBe(2);
  return score;
}

describe('independent Poisson score sampling with a bounded truncated tail', () => {
  it('uses two draws for a certain 0-0 and identifies the sampling convention', () => {
    const sampler = createPoissonScoreSampler(0, 0, {
      tailTolerance: Number.MIN_VALUE,
      maxGoals: 0,
    })!;

    expect(sampler.algorithm).toBe(POISSON_SCORE_SAMPLING_ALGORITHM);
    expect(sampler.algorithm).toBe('independent-poisson-conditioned-cdf-v1');
    expect(sampler.tailUpperBound).toBe(0);
    expect(sampleAt(sampler, 0, 1 - 2 ** -53)).toEqual({
      homeGoals: 0,
      awayGoals: 0,
    });
  });

  // Quantiles evaluated independently with 100-digit decimal arithmetic.
  // These values are away from boundaries, including the small discarded tail.
  it.each([
    { home: 0.05, away: 0.5, homeGoals: 0, awayGoals: 1 },
    { home: 0.5, away: 0.9, homeGoals: 1, awayGoals: 2 },
    { home: 0.9, away: 0.99, homeGoals: 3, awayGoals: 3 },
    { home: 0.999999, away: 0.999999, homeGoals: 10, awayGoals: 8 },
  ])('matches the reference quantiles $home / $away', (reference) => {
    const sampler = createPoissonScoreSampler(1.5, 0.8, options)!;
    expect(sampleAt(sampler, reference.home, reference.away)).toEqual({
      homeGoals: reference.homeGoals,
      awayGoals: reference.awayGoals,
    });
  });

  it('supports high scores beyond the display range without clipping them', () => {
    const sampler = createPoissonScoreSampler(2.64, 10, options)!;
    expect(sampleAt(sampler, 0.999999, 0.999999)).toEqual({
      homeGoals: 13,
      awayGoals: 28,
    });
  });

  it('conditions on the retained support instead of assigning the tail to its last goal', () => {
    const sampler = createPoissonScoreSampler(0.5, 0, {
      tailTolerance: 0.9,
      maxGoals: 1,
    })!;
    const marginal = calculatePoissonDistribution(0.5, {
      tailTolerance: 0.45,
      maxGoals: 1,
    })!;
    const boundary =
      marginal.probabilities[0]! /
      marginal.probabilities.reduce((sum, probability) => sum + probability, 0);

    // Conditioning changes P(0) from exp(-0.5) to approximately 2/3.
    expect(sampleAt(sampler, 0.65, 0.5).homeGoals).toBe(0);
    expect(sampleAt(sampler, boundary - Number.EPSILON, 0.5).homeGoals).toBe(0);
    expect(sampleAt(sampler, boundary, 0.5).homeGoals).toBe(1);
    expect(sampleAt(sampler, 1 - 2 ** -53, 0.5).homeGoals).toBe(1);
    expect(sampler.tailUpperBound).toBeGreaterThan(1 - 1.5 * Math.exp(-0.5));
    expect(sampler.tailUpperBound).toBeLessThanOrEqual(0.9);
  });

  it('keeps a positive tail bound even if the support contains only zero goals', () => {
    const sampler = createPoissonScoreSampler(0.05, 0.1, {
      tailTolerance: 0.5,
      maxGoals: 0,
    })!;
    expect(sampleAt(sampler, 0.9, 0.99)).toEqual({ homeGoals: 0, awayGoals: 0 });
    expect(sampler.tailUpperBound).toBeGreaterThan(1 - Math.exp(-0.15));
    expect(sampler.tailUpperBound).toBeLessThanOrEqual(0.5);
  });

  it('skips initial zero-mass entries when large-rate probabilities underflow', () => {
    const sampler = createPoissonScoreSampler(1000, 0, {
      tailTolerance: 1e-10,
      maxGoals: 2000,
    })!;
    const first = sampleAt(sampler, 0, 0);
    expect(first.homeGoals).toBeGreaterThan(0);
    expect(poissonProbability(first.homeGoals, 1000)).toBeGreaterThan(0);
    expect(poissonProbability(first.homeGoals - 1, 1000)).toBe(0);
    expect(sampleAt(sampler, 0.5, 0.9)).toEqual({ homeGoals: 1000, awayGoals: 0 });
    expect(sampleAt(sampler, 1 - 2 ** -53, 0).homeGoals).toBeLessThanOrEqual(2000);
  });

  it('exchanges the sampled score when the rates and corresponding draws are exchanged', () => {
    const normal = createPoissonScoreSampler(1.5, 0.8, options)!;
    const reversed = createPoissonScoreSampler(0.8, 1.5, options)!;
    const score = sampleAt(normal, 0.9, 0.1);
    expect(sampleAt(reversed, 0.1, 0.9)).toEqual({
      homeGoals: score.awayGoals,
      awayGoals: score.homeGoals,
    });
    expect(reversed.tailUpperBound).toBe(normal.tailUpperBound);
  });

  it('reproduces scores with the same seed and preserves the stream across batches', () => {
    const first = createPoissonScoreSampler(1.5, 0.8, options)!;
    const second = createPoissonScoreSampler(1.5, 0.8, options)!;
    const firstRandom = createSeededRandom([123, 456, 789, 101112]);
    const secondRandom = createSeededRandom([123, 456, 789, 101112]);
    const whole = Array.from({ length: 500 }, () => first.sample(firstRandom));
    const batched = [25, 100, 375].flatMap((length) =>
      Array.from({ length }, () => second.sample(secondRandom)),
    );
    expect(batched).toEqual(whole);
    expect(first.tailUpperBound).toBeLessThanOrEqual(options.tailTolerance);
  });

  it('matches independent moment and outcome references over a fixed 100000-score sample', () => {
    const sampler = createPoissonScoreSampler(1.5, 0.8, options)!;
    const random = createSeededRandom([123, 456, 789, 101112]);
    const count = 100_000;
    let homeSum = 0;
    let awaySum = 0;
    let homeSquareSum = 0;
    let awaySquareSum = 0;
    let productSum = 0;
    const outcomes = { home: 0, draw: 0, away: 0 };
    for (let index = 0; index < count; index += 1) {
      const { homeGoals: home, awayGoals: away } = sampler.sample(random);
      homeSum += home;
      awaySum += away;
      homeSquareSum += home * home;
      awaySquareSum += away * away;
      productSum += home * away;
      outcomes[home > away ? 'home' : home < away ? 'away' : 'draw'] += 1;
    }
    const homeMean = homeSum / count;
    const awayMean = awaySum / count;
    expect(Math.abs(homeMean - 1.5)).toBeLessThan(0.025);
    expect(Math.abs(awayMean - 0.8)).toBeLessThan(0.02);
    expect(Math.abs(homeSquareSum / count - homeMean ** 2 - 1.5)).toBeLessThan(0.05);
    expect(Math.abs(awaySquareSum / count - awayMean ** 2 - 0.8)).toBeLessThan(0.04);
    expect(Math.abs(productSum / count - homeMean * awayMean)).toBeLessThan(0.025);
    // Untruncated references; their differences from the conditional values
    // are bounded by tailUpperBound, far below these Monte Carlo tolerances.
    expect(Math.abs(outcomes.home / count - 0.5381655979967927)).toBeLessThan(0.008);
    expect(Math.abs(outcomes.draw / count - 0.26185391289739517)).toBeLessThan(
      0.008,
    );
    expect(Math.abs(outcomes.away / count - 0.1999804891058121)).toBeLessThan(0.008);
  });

  it.each([-1, 1, NaN, Infinity, -Infinity])(
    'rejects the invalid random value %s for either team',
    (uniform) => {
      // Even a zero-rate marginal must validate its supplied random value.
      const sampler = createPoissonScoreSampler(0, 0, options)!;
      expect(() => sampleAt(sampler, uniform, 0)).toThrow(RangeError);
      expect(() => sampleAt(sampler, 0, uniform)).toThrow(RangeError);
    },
  );

  it('returns null when either rate exceeds the calculation budget', () => {
    expect(createPoissonScoreSampler(Number.MAX_VALUE, 1, options)).toBeNull();
    expect(createPoissonScoreSampler(1, Number.MAX_VALUE, options)).toBeNull();
    expect(
      createPoissonScoreSampler(2.64, 2.64, {
        tailTolerance: 1e-10,
        maxGoals: 19,
      }),
    ).toBeNull();
  });

  it('checks the combined bound when dividing a subnormal tolerance', () => {
    const tinyOptions = { tailTolerance: Number.MIN_VALUE, maxGoals: 1 };
    const single = createPoissonScoreSampler(Number.MIN_VALUE, 0, tinyOptions)!;
    expect(single.tailUpperBound).toBe(Number.MIN_VALUE);
    expect(
      createPoissonScoreSampler(Number.MIN_VALUE, Number.MIN_VALUE, tinyOptions),
    ).toBeNull();
    expect(
      createPoissonScoreSampler(Number.MIN_VALUE, Number.MIN_VALUE, {
        tailTolerance: 2 * Number.MIN_VALUE,
        maxGoals: 1,
      })!.tailUpperBound,
    ).toBe(2 * Number.MIN_VALUE);
  });

  it('rejects invalid rates and options even when another marginal is unavailable', () => {
    for (const rate of [-1, NaN, Infinity, -Infinity]) {
      expect(() => createPoissonScoreSampler(rate, 0, options)).toThrow(RangeError);
      expect(() =>
        createPoissonScoreSampler(Number.MAX_VALUE, rate, options),
      ).toThrow(RangeError);
    }
    for (const tailTolerance of [0, -1, 1, 1.5, NaN, Infinity, -Infinity]) {
      expect(() =>
        createPoissonScoreSampler(0, 0, { tailTolerance, maxGoals: 0 }),
      ).toThrow(RangeError);
    }
    for (const maxGoals of [-1, 0.5, NaN, Infinity, 2 ** 32 - 1]) {
      expect(() =>
        createPoissonScoreSampler(0, 0, { tailTolerance: 1e-10, maxGoals }),
      ).toThrow(RangeError);
    }
  });
});
