import { describe, expect, it } from 'vitest';

import { calculateScoreDistribution } from './score-distribution';

const options = Object.freeze({ tailTolerance: 1e-10, maxGoals: 64 });

describe('independent Poisson score distribution', () => {
  it('concentrates two zero rates at a 0-0 score', () => {
    expect(
      calculateScoreDistribution(0, 0, {
        tailTolerance: Number.MIN_VALUE,
        maxGoals: 0,
      }),
    ).toEqual({ probabilities: [[1]], tailUpperBound: 0 });
  });

  it('matches high-precision score probabilities with home goals as rows', () => {
    // References evaluated with 100-digit decimal arithmetic.
    const result = calculateScoreDistribution(1.5, 0.8, options);

    expect(result!.probabilities[0]?.[0]).toBeCloseTo(0.10025884372280373, 15);
    expect(result!.probabilities[2]?.[1]).toBeCloseTo(0.09023295935052336, 15);
    expect(result!.probabilities[0]?.[2]).toBeCloseTo(0.032082829991297195, 15);
  });

  it('bounds the total discarded mass by the requested matrix tolerance', () => {
    for (const [homeRate, awayRate] of [
      [0, 0],
      [1.5, 0.8],
      [2.64, 2.64],
      [10, 8],
    ] as const) {
      const result = calculateScoreDistribution(homeRate, awayRate, options);
      const mass = result!.probabilities.reduce(
        (total, row) => total + row.reduce((sum, value) => sum + value, 0),
        0,
      );

      expect(result!.tailUpperBound).toBeLessThanOrEqual(options.tailTolerance);
      expect(mass).toBeGreaterThanOrEqual(1 - result!.tailUpperBound - 1e-14);
      expect(mass).toBeLessThanOrEqual(1 + 1e-14);
    }
  });

  it('keeps the retained score mass for a short permitted support', () => {
    const result = calculateScoreDistribution(0.05, 0.1, {
      tailTolerance: 0.5,
      maxGoals: 0,
    });

    expect(result!.probabilities).toHaveLength(1);
    expect(result!.probabilities[0]).toHaveLength(1);
    expect(result!.probabilities[0]?.[0]).toBeCloseTo(0.8607079764250578, 15);
    expect(result!.tailUpperBound).toBeGreaterThan(1 - 0.8607079764250578);
    expect(result!.tailUpperBound).toBeLessThanOrEqual(0.5);
  });

  it('transposes the matrix when home and away rates are exchanged', () => {
    const normal = calculateScoreDistribution(1.5, 0.8, options);
    const swapped = calculateScoreDistribution(0.8, 1.5, options);

    expect(normal!.probabilities).toHaveLength(swapped!.probabilities[0]!.length);
    expect(normal!.probabilities[0]).toHaveLength(swapped!.probabilities.length);
    for (const [homeGoals, row] of normal!.probabilities.entries()) {
      for (const [awayGoals, probability] of row.entries()) {
        expect(probability).toBe(swapped!.probabilities[awayGoals]?.[homeGoals]);
      }
    }
    expect(normal!.tailUpperBound).toBe(swapped!.tailUpperBound);
  });

  it('retains a large-rate mode when the opposing rate is zero', () => {
    const result = calculateScoreDistribution(1000, 0, {
      tailTolerance: 1e-10,
      maxGoals: 2000,
    });

    expect(result!.probabilities[0]).toEqual([0]);
    expect(result!.probabilities[1000]).toHaveLength(1);
    expect(result!.probabilities[1000]?.[0]).toBeCloseTo(0.0126146113487215, 15);
    expect(result!.tailUpperBound).toBeLessThanOrEqual(1e-10);
  });

  it('returns null when either marginal cannot certify the requested tolerance', () => {
    expect(calculateScoreDistribution(Number.MAX_VALUE, 1, options)).toBeNull();
    expect(calculateScoreDistribution(1, Number.MAX_VALUE, options)).toBeNull();
    expect(
      calculateScoreDistribution(2.64, 2.64, {
        tailTolerance: 1e-10,
        maxGoals: 19,
      }),
    ).toBeNull();
  });

  it('checks the combined bound when dividing a subnormal tolerance', () => {
    const tinyOptions = { tailTolerance: Number.MIN_VALUE, maxGoals: 1 };
    expect(calculateScoreDistribution(Number.MIN_VALUE, 0, tinyOptions)).toEqual({
      probabilities: [[1], [Number.MIN_VALUE]],
      tailUpperBound: Number.MIN_VALUE,
    });
    expect(
      calculateScoreDistribution(Number.MIN_VALUE, Number.MIN_VALUE, tinyOptions),
    ).toBeNull();
    expect(
      calculateScoreDistribution(Number.MIN_VALUE, Number.MIN_VALUE, {
        tailTolerance: 2 * Number.MIN_VALUE,
        maxGoals: 1,
      }),
    ).toEqual({
      probabilities: [
        [1, Number.MIN_VALUE],
        [Number.MIN_VALUE, 0],
      ],
      tailUpperBound: 2 * Number.MIN_VALUE,
    });
  });

  it('rejects invalid rates and options even when another marginal is unavailable', () => {
    for (const rate of [-1, NaN, -Infinity, Infinity]) {
      expect(() => calculateScoreDistribution(rate, 1, options)).toThrow(RangeError);
      expect(() => calculateScoreDistribution(1, rate, options)).toThrow(RangeError);
      expect(() =>
        calculateScoreDistribution(Number.MAX_VALUE, rate, options),
      ).toThrow(RangeError);
    }
    for (const tailTolerance of [0, -1, 1, 2, NaN, Infinity]) {
      expect(() =>
        calculateScoreDistribution(0, 0, { tailTolerance, maxGoals: 0 }),
      ).toThrow(RangeError);
    }
    expect(() =>
      calculateScoreDistribution(0, 0, { tailTolerance: 1e-10, maxGoals: -1 }),
    ).toThrow(RangeError);
  });
});
