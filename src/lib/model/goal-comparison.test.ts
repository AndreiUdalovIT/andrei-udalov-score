import { describe, expect, it } from 'vitest';

import type { ExpectedGoals } from './expected-goals';
import { compareGoalForecasts, type GoalForecastCandidate } from './goal-comparison';
import type { WalkForwardGoalRow } from './goal-walk-forward';

function row(
  id: number,
  homeGoals90: number,
  awayGoals90: number,
  expectedGoals: ExpectedGoals | null,
): WalkForwardGoalRow {
  return Object.freeze({
    id,
    before: new Date(Date.UTC(2026, 0, id, 12)),
    homeGoals90,
    awayGoals90,
    expectedGoals: expectedGoals === null ? null : Object.freeze(expectedGoals),
  });
}

const first = Object.freeze([
  row(4, 0, 0, { home: 0, away: 0, lowData: false }),
  row(3, 2, 0, null),
  row(2, 0, 0, { home: 100, away: 100, lowData: false }),
  row(1, 2, 0, { home: 1, away: 1, lowData: true }),
]);
const second = Object.freeze([
  row(2, 0, 0, null),
  row(4, 0, 0, { home: 1, away: 1, lowData: true }),
  row(1, 2, 0, { home: 2, away: 0, lowData: false }),
  row(3, 2, 0, { home: 0, away: 0, lowData: true }),
]);
const candidates: readonly GoalForecastCandidate[] = Object.freeze([
  Object.freeze({ id: 'first', rows: first }),
  Object.freeze({ id: 'second', rows: second }),
]);

describe('goal forecast comparison', () => {
  it('scores a common chronological fixture set and reports full coverage', () => {
    const result = compareGoalForecasts(candidates);

    expect(result.matchCount).toBe(4);
    expect(result.commonMatchIds).toEqual([1, 4]);
    expect(result.candidates[0]).toMatchObject({
      id: 'first',
      forecastCount: 3,
      lowDataCount: 1,
      common: { matchCount: 2, forecastCount: 2, lowDataCount: 1 },
    });
    expect(result.candidates[1]).toEqual({
      id: 'second',
      forecastCount: 3,
      lowDataCount: 2,
      common: {
        matchCount: 2,
        forecastCount: 2,
        lowDataCount: 1,
        meanPoissonDeviance: 1,
      },
    });
    expect(result.candidates[0]?.common.meanPoissonDeviance).toBeCloseTo(
      Math.log(2),
      12,
    );
    expect(first.map((sample) => sample.id)).toEqual([4, 3, 2, 1]);
    expect(second.map((sample) => sample.id)).toEqual([2, 4, 1, 3]);
  });

  it('keeps per-candidate scores stable when candidate and row order change', () => {
    const original = compareGoalForecasts(candidates);
    const reordered = compareGoalForecasts(
      [...candidates].reverse().map((candidate) => ({
        ...candidate,
        rows: [...candidate.rows].reverse(),
      })),
    );

    expect(reordered.commonMatchIds).toEqual(original.commonMatchIds);
    expect([...reordered.candidates].reverse()).toEqual(original.candidates);
  });

  it('supports empty candidates and one candidate while retaining missing rows', () => {
    expect(compareGoalForecasts([])).toEqual({
      matchCount: 0,
      commonMatchIds: [],
      candidates: [],
    });
    const empty = compareGoalForecasts([
      { id: 'first', rows: [] },
      { id: 'second', rows: [] },
    ]);
    expect(empty.matchCount).toBe(0);
    expect(empty.commonMatchIds).toEqual([]);
    expect(
      empty.candidates.every(
        (candidate) =>
          candidate.forecastCount === 0 &&
          candidate.common.meanPoissonDeviance === null,
      ),
    ).toBe(true);

    const single = compareGoalForecasts([{ id: 'first', rows: first }]);
    expect(single.matchCount).toBe(4);
    expect(single.commonMatchIds).toEqual([1, 2, 4]);
    expect(single.candidates[0]?.forecastCount).toBe(3);
    expect(single.candidates[0]?.common.forecastCount).toBe(3);
  });

  it('keeps common metrics absent for disjoint or wholly unavailable forecasts', () => {
    const prediction = { home: 1, away: 1, lowData: false };
    for (const [firstPrediction, secondPrediction] of [
      [prediction, prediction],
      [null, null],
    ] as const) {
      const result = compareGoalForecasts([
        {
          id: 'first',
          rows: [row(1, 0, 0, firstPrediction), row(2, 0, 0, null)],
        },
        {
          id: 'second',
          rows: [row(1, 0, 0, null), row(2, 0, 0, secondPrediction)],
        },
      ]);

      expect(result.matchCount).toBe(2);
      expect(result.commonMatchIds).toEqual([]);
      expect(result.candidates.map((candidate) => candidate.common)).toEqual([
        {
          matchCount: 0,
          forecastCount: 0,
          lowDataCount: 0,
          meanPoissonDeviance: null,
        },
        {
          matchCount: 0,
          forecastCount: 0,
          lowDataCount: 0,
          meanPoissonDeviance: null,
        },
      ]);
    }
  });

  it('retains an infinite loss on the common fixture set', () => {
    const result = compareGoalForecasts([
      {
        id: 'zero',
        rows: [row(1, 1, 0, { home: 0, away: 0, lowData: false })],
      },
      {
        id: 'positive',
        rows: [row(1, 1, 0, { home: 1, away: 0, lowData: false })],
      },
    ]);

    expect(result.commonMatchIds).toEqual([1]);
    expect(result.candidates[0]?.common.meanPoissonDeviance).toBe(Infinity);
    expect(result.candidates[1]?.common.meanPoissonDeviance).toBe(0);
  });

  it('rejects inconsistent fixture sets, outcomes and kickoff cutoffs', () => {
    const sample = row(1, 2, 1, null);
    for (const rows of [
      [],
      [row(2, 2, 1, null)],
      [{ ...sample, homeGoals90: 3 }],
      [{ ...sample, awayGoals90: 0 }],
      [{ ...sample, before: new Date(sample.before.getTime() + 1) }],
      [{ ...sample, before: new Date(NaN) }],
    ]) {
      expect(() =>
        compareGoalForecasts([
          { id: 'first', rows: [sample] },
          { id: 'second', rows },
        ]),
      ).toThrow(RangeError);
    }
    expect(() =>
      compareGoalForecasts([
        { id: 'invalid', rows: [{ ...sample, before: new Date(NaN) }] },
      ]),
    ).toThrow(RangeError);
  });

  it('rejects duplicate candidate and fixture IDs', () => {
    expect(() =>
      compareGoalForecasts([
        { id: 'same', rows: [] },
        { id: 'same', rows: [] },
      ]),
    ).toThrow('forecast candidate IDs must be unique');
    const sample = row(1, 2, 1, null);
    expect(() =>
      compareGoalForecasts([{ id: 'first', rows: [sample, sample] }]),
    ).toThrow('validation match IDs must be unique');
    expect(() =>
      compareGoalForecasts([
        { id: 'first', rows: [sample, row(2, 0, 0, null)] },
        { id: 'second', rows: [sample, sample] },
      ]),
    ).toThrow('validation match IDs must be unique');
  });

  it('validates scores and rates even outside the common fixture set', () => {
    for (const invalid of [
      row(2, -1, 0, null),
      row(2, 0, 0, { home: NaN, away: 1, lowData: false }),
    ]) {
      expect(() =>
        compareGoalForecasts([
          {
            id: 'first',
            rows: [first[3]!, invalid],
          },
          {
            id: 'second',
            rows: [second[2]!, row(2, 0, 0, null)],
          },
        ]),
      ).toThrow(RangeError);
    }
  });
});
