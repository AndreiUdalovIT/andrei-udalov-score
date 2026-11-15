import { describe, expect, it } from 'vitest';

import { halfPoissonDeviance, poissonProbability } from './poisson';

describe('Poisson probability', () => {
  it('concentrates a zero-rate distribution at zero goals', () => {
    expect(poissonProbability(0, 0)).toBe(1);
    for (const goals of [1, 15, 16, Number.MAX_SAFE_INTEGER]) {
      expect(poissonProbability(goals, 0)).toBe(0);
    }
  });

  it('matches high-precision reference probabilities across both formulas', () => {
    // References evaluated with 100-digit decimal arithmetic.
    const cases = [
      { goals: 1, rate: 0.01, probability: 0.0099004983374916805 },
      { goals: 3, rate: 2.64, probability: 0.21883818189208285 },
      { goals: 15, rate: 15, probability: 0.10243586666453419 },
      { goals: 16, rate: 16, probability: 0.09921753162215582 },
      { goals: 17, rate: 17, probability: 0.09628462779844534 },
      { goals: 1000, rate: 1000, probability: 0.0126146113487215 },
      { goals: 1e8, rate: 1e8, probability: 0.00003989422800689808 },
      {
        goals: Number.MAX_SAFE_INTEGER,
        rate: Number.MAX_SAFE_INTEGER,
        probability: 4.203539964167448e-9,
      },
    ];

    for (const sample of cases) {
      const actual = poissonProbability(sample.goals, sample.rate);
      expect(actual / sample.probability).toBeCloseTo(1, 13);
    }
  });

  it('preserves the adjacent-probability recurrence across the formula boundary', () => {
    const rate = 16;
    for (let goals = 0; goals < 32; goals += 1) {
      const current = poissonProbability(goals, rate);
      const next = poissonProbability(goals + 1, rate);
      expect(next / current).toBeCloseTo(rate / (goals + 1), 12);
    }
  });

  it('recovers total mass, mean and variance on sufficiently wide supports', () => {
    for (const rate of [0, 0.01, 1, 2.64, 10, 40, 1000]) {
      let mass = 0;
      let mean = 0;
      let variance = 0;
      for (let goals = 0; goals <= 1400; goals += 1) {
        const probability = poissonProbability(goals, rate);
        mass += probability;
        mean += goals * probability;
        variance += (goals - rate) ** 2 * probability;
      }

      expect(mass).toBeCloseTo(1, 12);
      expect(mean).toBeCloseTo(rate, 10);
      expect(variance).toBeCloseTo(rate, 10);
    }
  });

  it('handles representable tiny probabilities and extreme finite rates', () => {
    expect(poissonProbability(0, Number.MIN_VALUE)).toBe(1);
    expect(poissonProbability(1, Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(poissonProbability(0, Number.MAX_VALUE)).toBe(0);
    expect(poissonProbability(16, Number.MAX_VALUE)).toBe(0);
    expect(poissonProbability(16, Number.MIN_VALUE)).toBe(0);
  });

  it('rejects invalid counts and rates, including at the zero-rate boundary', () => {
    for (const goals of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => poissonProbability(goals, 0)).toThrow(RangeError);
      expect(() => halfPoissonDeviance(goals, 0)).toThrow(RangeError);
    }
    for (const rate of [-1, NaN, -Infinity, Infinity]) {
      for (const goals of [0, 1, 16]) {
        expect(() => poissonProbability(goals, rate)).toThrow(RangeError);
        expect(() => halfPoissonDeviance(goals, rate)).toThrow(RangeError);
      }
    }
  });
});
