import { describe, expect, it } from 'vitest';

import { calculateMatchProbabilities } from './match-probabilities';

const options = Object.freeze({ tailTolerance: 1e-14, maxGoals: 64 });

describe('match probabilities from independent Poisson scores', () => {
  it('assigns two zero rates to a draw with no goals', () => {
    expect(calculateMatchProbabilities(0, 0, options)).toEqual({
      probabilities: [[1]],
      tailUpperBound: 0,
      outcomes: { home: 0, draw: 1, away: 0 },
      over25: 0,
      bothTeamsToScore: 0,
    });
  });

  it('matches independent 100-digit references for all five markets', () => {
    const result = calculateMatchProbabilities(1.5, 0.8, options);

    expect(result!.outcomes.home).toBeCloseTo(0.5381655979967927, 13);
    expect(result!.outcomes.draw).toBeCloseTo(0.26185391289739517, 13);
    expect(result!.outcomes.away).toBeCloseTo(0.1999804891058121, 13);
    expect(result!.over25).toBeCloseTo(0.4039611740679318, 13);
    expect(result!.bothTeamsToScore).toBeCloseTo(0.4277997194571523, 13);
    expect(result!.probabilities[2]?.[1]).toBeCloseTo(0.09023295935052336, 15);
    expect(result!.tailUpperBound).toBeLessThanOrEqual(options.tailTolerance);
  });

  it('handles a confirmed zero rate for either team', () => {
    const away = calculateMatchProbabilities(0, 2, options);
    const home = calculateMatchProbabilities(2, 0, options);

    expect(away!.outcomes.home).toBe(0);
    expect(away!.outcomes.draw).toBeCloseTo(0.1353352832366127, 13);
    expect(away!.outcomes.away).toBeCloseTo(0.8646647167633873, 13);
    expect(away!.over25).toBeCloseTo(0.32332358381693654, 13);
    expect(away!.bothTeamsToScore).toBe(0);
    expect(home!.outcomes.away).toBe(0);
    expect(home!.outcomes.home).toBeCloseTo(away!.outcomes.away, 13);
    expect(home!.over25).toBeCloseTo(away!.over25, 13);
    expect(home!.bothTeamsToScore).toBe(0);
  });

  it('preserves symmetry and bounds the missing outcome mass', () => {
    for (const [homeRate, awayRate] of [
      [1.5, 0.8],
      [2.64, 2.64],
      [10, 8],
    ] as const) {
      const normal = calculateMatchProbabilities(homeRate, awayRate, options);
      const swapped = calculateMatchProbabilities(awayRate, homeRate, options);

      expect(normal!.outcomes.home).toBeCloseTo(swapped!.outcomes.away, 13);
      expect(normal!.outcomes.away).toBeCloseTo(swapped!.outcomes.home, 13);
      expect(normal!.outcomes.draw).toBeCloseTo(swapped!.outcomes.draw, 13);
      expect(normal!.over25).toBeCloseTo(swapped!.over25, 13);
      expect(normal!.bothTeamsToScore).toBeCloseTo(swapped!.bothTeamsToScore, 13);
      const mass =
        normal!.outcomes.home + normal!.outcomes.draw + normal!.outcomes.away;
      expect(mass).toBeGreaterThanOrEqual(1 - normal!.tailUpperBound - 1e-14);
      expect(mass).toBeLessThanOrEqual(1 + 1e-14);
    }
  });

  it('retains the score mass allowed by a loose truncation tolerance', () => {
    const result = calculateMatchProbabilities(0.05, 0.1, {
      tailTolerance: 0.5,
      maxGoals: 0,
    });

    expect(result!.outcomes.home).toBe(0);
    expect(result!.outcomes.away).toBe(0);
    expect(result!.outcomes.draw).toBeCloseTo(0.8607079764250578, 15);
    expect(result!.over25).toBe(0);
    expect(result!.bothTeamsToScore).toBe(0);
    expect(result!.tailUpperBound).toBeGreaterThan(1 - result!.outcomes.draw);
  });

  it('retains rare events at small positive rates', () => {
    const result = calculateMatchProbabilities(1e-8, 1e-8, {
      tailTolerance: 1e-40,
      maxGoals: 64,
    });

    expect(result!.over25 / 1.3333333133333335e-24).toBeCloseTo(1, 12);
    expect(result!.bothTeamsToScore / 9.999999900000001e-17).toBeCloseTo(1, 12);
  });

  it('keeps accumulated probabilities within their valid range near one', () => {
    for (let rate = 40; rate <= 50; rate += 0.5) {
      const result = calculateMatchProbabilities(rate, rate, {
        tailTolerance: 1e-40,
        maxGoals: 256,
      });
      const values = [
        ...Object.values(result!.outcomes),
        result!.over25,
        result!.bothTeamsToScore,
      ];
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('propagates unavailable distributions and invalid input errors', () => {
    expect(calculateMatchProbabilities(Number.MAX_VALUE, 1, options)).toBeNull();
    expect(calculateMatchProbabilities(1, Number.MAX_VALUE, options)).toBeNull();
    expect(() => calculateMatchProbabilities(-1, 1, options)).toThrow(RangeError);
    expect(() =>
      calculateMatchProbabilities(Number.MAX_VALUE, NaN, options),
    ).toThrow(RangeError);
    expect(() =>
      calculateMatchProbabilities(0, 0, { tailTolerance: 1, maxGoals: 64 }),
    ).toThrow(RangeError);
    expect(() =>
      calculateMatchProbabilities(0, 0, { tailTolerance: 1e-10, maxGoals: -1 }),
    ).toThrow(RangeError);
  });
});
