import { describe, expect, it } from 'vitest';

import { scoreGoalForecasts, type GoalValidationRow } from './goal-validation';

const sample: GoalValidationRow = Object.freeze({
  id: 1,
  homeGoals90: 2,
  awayGoals90: 0,
  expectedGoals: Object.freeze({ home: 1, away: 1, lowData: false }),
});

describe('goal forecast validation', () => {
  it('averages both goal observations and reports forecast availability', () => {
    const result = scoreGoalForecasts(
      Object.freeze([
        sample,
        Object.freeze({
          id: 2,
          homeGoals90: 2,
          awayGoals90: 1,
          expectedGoals: Object.freeze({ home: 2, away: 1, lowData: true }),
        }),
        Object.freeze({ ...sample, id: 3, expectedGoals: null }),
      ]),
    );

    expect(result.matchCount).toBe(3);
    expect(result.forecastCount).toBe(2);
    expect(result.lowDataCount).toBe(1);
    expect(result.meanPoissonDeviance).toBeCloseTo(Math.log(2), 12);
    expect(scoreGoalForecasts([sample]).meanPoissonDeviance).toBeCloseTo(
      2 * Math.log(2),
      12,
    );
  });

  it('keeps an empty or unavailable validation score absent', () => {
    expect(scoreGoalForecasts([])).toEqual({
      matchCount: 0,
      forecastCount: 0,
      lowDataCount: 0,
      meanPoissonDeviance: null,
    });
    expect(scoreGoalForecasts([{ ...sample, expectedGoals: null }])).toEqual({
      matchCount: 1,
      forecastCount: 0,
      lowDataCount: 0,
      meanPoissonDeviance: null,
    });
  });

  it('uses the Poisson limit at zero and retains infinite loss across matches', () => {
    const zero: GoalValidationRow = {
      id: 1,
      homeGoals90: 0,
      awayGoals90: 0,
      expectedGoals: { home: 0, away: 0, lowData: false },
    };

    expect(scoreGoalForecasts([zero]).meanPoissonDeviance).toBe(0);
    expect(
      scoreGoalForecasts([
        { ...zero, expectedGoals: { home: 2, away: 1, lowData: false } },
      ]).meanPoissonDeviance,
    ).toBe(3);
    const impossible = { ...zero, homeGoals90: 1 };
    expect(
      scoreGoalForecasts([impossible, { ...zero, id: 2 }]).meanPoissonDeviance,
    ).toBe(Infinity);
    expect(
      scoreGoalForecasts([{ ...zero, id: 2 }, impossible]).meanPoissonDeviance,
    ).toBe(Infinity);
    expect(
      scoreGoalForecasts([
        {
          ...impossible,
          expectedGoals: { home: Number.MIN_VALUE, away: 0, lowData: false },
        },
      ]).meanPoissonDeviance,
    ).toBeCloseTo(-1 - Math.log(Number.MIN_VALUE), 12);
  });

  it('handles near-equal and extreme finite rates without losing the average', () => {
    const home = 3 + 1e-9;
    const away = 2 - 1e-9;
    const close = scoreGoalForecasts([
      {
        id: 1,
        homeGoals90: 3,
        awayGoals90: 2,
        expectedGoals: { home, away, lowData: false },
      },
    ]);
    const approximation = (home - 3) ** 2 / 6 + (away - 2) ** 2 / 4;

    expect(close.meanPoissonDeviance! / approximation).toBeCloseTo(1, 8);
    expect(
      scoreGoalForecasts([
        {
          id: 1,
          homeGoals90: 0,
          awayGoals90: 0,
          expectedGoals: { home: Number.MAX_VALUE, away: 0, lowData: false },
        },
        {
          id: 2,
          homeGoals90: 0,
          awayGoals90: 0,
          expectedGoals: { home: Number.MAX_VALUE, away: 0, lowData: false },
        },
      ]).meanPoissonDeviance,
    ).toBe(Number.MAX_VALUE);
  });

  it('rejects invalid scores even for unavailable forecasts and invalid rates', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        scoreGoalForecasts([{ ...sample, homeGoals90: value, expectedGoals: null }]),
      ).toThrow(RangeError);
      expect(() =>
        scoreGoalForecasts([{ ...sample, awayGoals90: value, expectedGoals: null }]),
      ).toThrow(RangeError);
    }
    for (const value of [-1, NaN, Infinity]) {
      expect(() =>
        scoreGoalForecasts([
          { ...sample, expectedGoals: { home: value, away: 1, lowData: false } },
        ]),
      ).toThrow(RangeError);
      expect(() =>
        scoreGoalForecasts([
          { ...sample, expectedGoals: { home: 1, away: value, lowData: false } },
        ]),
      ).toThrow(RangeError);
    }
  });

  it('rejects repeated match IDs including unavailable forecasts', () => {
    expect(() => scoreGoalForecasts([sample, sample])).toThrow(RangeError);
    expect(() =>
      scoreGoalForecasts([sample, { ...sample, expectedGoals: null }]),
    ).toThrow(RangeError);
  });
});
