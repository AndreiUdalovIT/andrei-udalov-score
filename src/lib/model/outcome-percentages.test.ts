import { describe, expect, it } from 'vitest';

import { roundOutcomePercentages } from './outcome-percentages';

describe('whole outcome percentages by largest remainders', () => {
  it('allocates the remaining points to the largest fractional parts', () => {
    expect(
      roundOutcomePercentages({ home: 0.338, draw: 0.337, away: 0.325 }),
    ).toEqual({ home: 34, draw: 34, away: 32 });
  });

  it('resolves equal remainders in home, draw, away order', () => {
    expect(
      roundOutcomePercentages({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }),
    ).toEqual({ home: 34, draw: 33, away: 33 });
    expect(
      roundOutcomePercentages({ home: 0.335, draw: 0.33, away: 0.335 }),
    ).toEqual({ home: 34, draw: 33, away: 33 });
  });

  it('normalizes the retained outcome mass for display', () => {
    expect(roundOutcomePercentages({ home: 0.46, draw: 0.25, away: 0.28 })).toEqual({
      home: 47,
      draw: 25,
      away: 28,
    });
  });

  it('preserves every partition already expressed in integer percentages', () => {
    for (let home = 0; home <= 100; home += 1) {
      for (let draw = 0; draw <= 100 - home; draw += 1) {
        const away = 100 - home - draw;
        expect(
          roundOutcomePercentages({
            home: home / 100,
            draw: draw / 100,
            away: away / 100,
          }),
        ).toEqual({ home, draw, away });
      }
    }
  });

  it('handles zero and subnormal probabilities', () => {
    expect(roundOutcomePercentages({ home: 0, draw: 1, away: 0 })).toEqual({
      home: 0,
      draw: 100,
      away: 0,
    });
    expect(
      roundOutcomePercentages({
        home: Number.MIN_VALUE,
        draw: Number.MIN_VALUE,
        away: Number.MIN_VALUE,
      }),
    ).toEqual({ home: 34, draw: 33, away: 33 });
    expect(
      roundOutcomePercentages({ home: Number.MIN_VALUE, draw: 0, away: 1 }),
    ).toEqual({ home: 0, draw: 0, away: 100 });
  });

  it('returns tied display values for distinct immutable input probabilities', () => {
    const probabilities = Object.freeze({ home: 0.499, draw: 0, away: 0.501 });
    expect(roundOutcomePercentages(probabilities)).toEqual({
      home: 50,
      draw: 0,
      away: 50,
    });
    expect(probabilities).toEqual({ home: 0.499, draw: 0, away: 0.501 });
  });

  it('rejects invalid probabilities and a zero total', () => {
    expect(() => roundOutcomePercentages({ home: 0, draw: 0, away: 0 })).toThrow(
      RangeError,
    );
    for (const outcome of ['home', 'draw', 'away'] as const) {
      for (const value of [-1, 1.01, NaN, Infinity, -Infinity]) {
        expect(() =>
          roundOutcomePercentages({
            home: 0.4,
            draw: 0.3,
            away: 0.3,
            [outcome]: value,
          }),
        ).toThrow(RangeError);
      }
    }
  });
});
