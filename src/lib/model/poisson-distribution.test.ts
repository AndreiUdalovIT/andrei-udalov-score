import { describe, expect, it } from 'vitest';

import { calculatePoissonDistribution } from './poisson-distribution';

describe('Poisson distribution with a bounded upper tail', () => {
  it('represents a zero rate exactly, including the smallest tolerance', () => {
    expect(
      calculatePoissonDistribution(0, {
        tailTolerance: Number.MIN_VALUE,
        maxGoals: 2 ** 32 - 2,
      }),
    ).toEqual({ probabilities: [1], tailUpperBound: 0 });
  });

  it('retains the original mass when the requested tolerance allows a short support', () => {
    const result = calculatePoissonDistribution(0.1, {
      tailTolerance: 0.25,
      maxGoals: 0,
    });

    expect(result?.probabilities).toEqual([Math.exp(-0.1)]);
    expect(result!.tailUpperBound).toBeGreaterThan(0.09516258196404043);
    expect(result!.tailUpperBound).toBeLessThanOrEqual(0.25);
  });

  it('bounds independent high-precision tail references at the selected cutoffs', () => {
    // Tails were summed with 100-digit decimal arithmetic.
    const cases = [
      { rate: 2.64, lastGoal: 19, tail: 9.0649539167044e-12 },
      { rate: 10, lastGoal: 38, tail: 2.959881457540258e-12 },
      { rate: 1000, lastGoal: 1222, tail: 5.165377568620602e-12 },
    ];
    for (const sample of cases) {
      const result = calculatePoissonDistribution(sample.rate, {
        tailTolerance: 1e-10,
        maxGoals: sample.lastGoal,
      });

      expect(result).not.toBeNull();
      expect(result!.probabilities).toHaveLength(sample.lastGoal + 1);
      expect(result!.tailUpperBound).toBeGreaterThanOrEqual(sample.tail);
      expect(result!.tailUpperBound).toBeLessThanOrEqual(1e-10);
      const mass = result!.probabilities.reduce((sum, value) => sum + value, 0);
      expect(1 - mass).toBeCloseTo(sample.tail, 14);
    }
  });

  it('expands beyond the display grid and retains mass around a large-rate mode', () => {
    const result = calculatePoissonDistribution(1000, {
      tailTolerance: 1e-10,
      maxGoals: 2000,
    });

    expect(result!.probabilities.length).toBeGreaterThan(7);
    expect(result!.probabilities[0]).toBe(0);
    expect(result!.probabilities[1000]).toBeCloseTo(0.0126146113487215, 15);
    const mass = result!.probabilities.reduce((sum, value) => sum + value, 0);
    expect(mass).toBeGreaterThan(1 - 1e-10);
  });

  it('extends the support for tighter tolerances while preserving shared entries', () => {
    const loose = calculatePoissonDistribution(10, {
      tailTolerance: 1e-3,
      maxGoals: 128,
    });
    const tight = calculatePoissonDistribution(10, {
      tailTolerance: 1e-10,
      maxGoals: 128,
    });

    expect(tight!.probabilities.length).toBeGreaterThan(loose!.probabilities.length);
    expect(tight!.tailUpperBound).toBeLessThan(loose!.tailUpperBound);
    expect(tight!.probabilities.slice(0, loose!.probabilities.length)).toEqual(
      loose!.probabilities,
    );
  });

  it('returns null when the bound cannot meet the tolerance within the budget', () => {
    for (const rate of [0.1, 2.64, 1000, Number.MAX_VALUE]) {
      expect(
        calculatePoissonDistribution(rate, {
          tailTolerance: 1e-10,
          maxGoals: 0,
        }),
      ).toBeNull();
    }
    expect(
      calculatePoissonDistribution(2.64, {
        tailTolerance: 1e-10,
        maxGoals: 18,
      }),
    ).toBeNull();
  });

  it('keeps a positive tail bound for subnormal rates and tolerances', () => {
    const result = calculatePoissonDistribution(Number.MIN_VALUE, {
      tailTolerance: Number.MIN_VALUE,
      maxGoals: 1,
    });

    expect(result).toEqual({
      probabilities: [1, Number.MIN_VALUE],
      tailUpperBound: Number.MIN_VALUE,
    });
  });

  it('validates all inputs, including options for a zero-rate distribution', () => {
    for (const rate of [-1, NaN, -Infinity, Infinity]) {
      expect(() =>
        calculatePoissonDistribution(rate, { tailTolerance: 1e-10, maxGoals: 64 }),
      ).toThrow(RangeError);
    }
    for (const tailTolerance of [0, -1, 1, 2, NaN, Infinity, -Infinity]) {
      expect(() =>
        calculatePoissonDistribution(0, { tailTolerance, maxGoals: 0 }),
      ).toThrow(RangeError);
    }
    for (const maxGoals of [-1, 0.5, NaN, Infinity, 2 ** 32 - 1]) {
      expect(() =>
        calculatePoissonDistribution(0, { tailTolerance: 1e-10, maxGoals }),
      ).toThrow(RangeError);
    }
  });
});
