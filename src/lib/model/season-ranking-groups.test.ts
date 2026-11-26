import { describe, expect, it } from 'vitest';

import {
  groupSeasonRankings,
  type SeasonRankingEntry,
} from './season-ranking-groups';

const entries = Object.freeze([
  Object.freeze({ teamId: 30, criteria: Object.freeze([70, 20, 50]) }),
  Object.freeze({ teamId: 10, criteria: Object.freeze([75, -5, 30]) }),
  Object.freeze({ teamId: 20, criteria: Object.freeze([70, 25, 40]) }),
  Object.freeze({ teamId: 40, criteria: Object.freeze([70, 20, 55]) }),
  Object.freeze({ teamId: 50, criteria: Object.freeze([70, 20, 50]) }),
]);

describe('season positions grouped by ordered ranking criteria', () => {
  it('applies a points, goal difference and goals scored prefix and retains equal positions', () => {
    expect(groupSeasonRankings(entries)).toEqual([
      { from: 1, to: 1, teamIds: [10], reason: 'resolved', missingCriterion: null },
      { from: 2, to: 2, teamIds: [20], reason: 'resolved', missingCriterion: null },
      { from: 3, to: 3, teamIds: [40], reason: 'resolved', missingCriterion: null },
      {
        from: 4,
        to: 5,
        teamIds: [30, 50],
        reason: 'equal-criteria',
        missingCriterion: null,
      },
    ]);
  });

  it('keeps a fully equal group together and advances the next position by its size', () => {
    expect(
      groupSeasonRankings([
        { teamId: 8, criteria: [10] },
        { teamId: 2, criteria: [10] },
        { teamId: 5, criteria: [9] },
      ]),
    ).toEqual([
      {
        from: 1,
        to: 2,
        teamIds: [2, 8],
        reason: 'equal-criteria',
        missingCriterion: null,
      },
      { from: 3, to: 3, teamIds: [5], reason: 'resolved', missingCriterion: null },
    ]);
  });

  it('stops a tied group at missing data before considering later criteria', () => {
    expect(
      groupSeasonRankings([
        { teamId: 3, criteria: [10, null, 999] },
        { teamId: 2, criteria: [10, 5, 1] },
        { teamId: 1, criteria: [9, 99, 99] },
      ]),
    ).toEqual([
      {
        from: 1,
        to: 2,
        teamIds: [2, 3],
        reason: 'missing-criterion',
        missingCriterion: 1,
      },
      { from: 3, to: 3, teamIds: [1], reason: 'resolved', missingCriterion: null },
    ]);
  });

  it('can resolve earlier groups while later groups need additional data', () => {
    expect(
      groupSeasonRankings([
        { teamId: 1, criteria: [20, null] },
        { teamId: 2, criteria: [10, null] },
        { teamId: 3, criteria: [10, 99] },
      ]),
    ).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'resolved', missingCriterion: null },
      {
        from: 2,
        to: 3,
        teamIds: [2, 3],
        reason: 'missing-criterion',
        missingCriterion: 1,
      },
    ]);
  });

  it('retains the whole range when the first criterion is missing', () => {
    expect(
      groupSeasonRankings([
        { teamId: 7, criteria: [null, 99] },
        { teamId: 3, criteria: [10, 1] },
      ]),
    ).toEqual([
      {
        from: 1,
        to: 2,
        teamIds: [3, 7],
        reason: 'missing-criterion',
        missingCriterion: 0,
      },
    ]);
  });

  it('supports empty inputs and a single team with missing values', () => {
    expect(groupSeasonRankings([])).toEqual([]);
    expect(groupSeasonRankings([{ teamId: 1, criteria: [null] }])).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'resolved', missingCriterion: null },
    ]);
  });

  it('orders finite decimals and negative criteria and treats signed zero equally', () => {
    expect(
      groupSeasonRankings([
        { teamId: 3, criteria: [1.5, -2.5, 999] },
        { teamId: 2, criteria: [1.5, -2.25, -0] },
        { teamId: 1, criteria: [1.5, -2.25, 0] },
      ]),
    ).toEqual([
      {
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'equal-criteria',
        missingCriterion: null,
      },
      { from: 3, to: 3, teamIds: [3], reason: 'resolved', missingCriterion: null },
    ]);
  });

  it('compares extreme finite values without subtracting them', () => {
    const result = groupSeasonRankings([
      { teamId: 1, criteria: [-Number.MAX_VALUE] },
      { teamId: Number.MAX_SAFE_INTEGER, criteria: [Number.MAX_VALUE] },
    ]);
    expect(result.map(({ teamIds }) => teamIds)).toEqual([
      [Number.MAX_SAFE_INTEGER],
      [1],
    ]);
  });

  it('keeps group membership and ranges stable for reordered input', () => {
    const expected = groupSeasonRankings(entries);
    expect(groupSeasonRankings([...entries].reverse())).toEqual(expected);
    expect(
      groupSeasonRankings([...entries.slice(2), ...entries.slice(0, 2)]),
    ).toEqual(expected);
  });

  it('returns independent objects and preserves frozen input values', () => {
    const result = groupSeasonRankings(entries);
    result[0]!.from = 999;
    result[3]!.teamIds.reverse();
    expect(groupSeasonRankings(entries)[0]!.from).toBe(1);
    expect(groupSeasonRankings(entries)[3]!.teamIds).toEqual([30, 50]);
    expect(entries.map(({ teamId }) => teamId)).toEqual([30, 10, 20, 40, 50]);
  });

  it('rejects duplicate team IDs', () => {
    expect(() =>
      groupSeasonRankings([
        { teamId: 1, criteria: [1] },
        { teamId: 1, criteria: [2] },
      ]),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid team ID %s',
    (teamId) => {
      expect(() => groupSeasonRankings([{ teamId, criteria: [1] }])).toThrow(
        RangeError,
      );
    },
  );

  it('requires non-empty and equally sized criteria sequences', () => {
    expect(() => groupSeasonRankings([{ teamId: 1, criteria: [] }])).toThrow(
      RangeError,
    );
    expect(() =>
      groupSeasonRankings([
        { teamId: 1, criteria: [1] },
        { teamId: 2, criteria: [1, 2] },
      ]),
    ).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, undefined, '1'])(
    'rejects an invalid criterion %s even after a decisive value',
    (value) => {
      const invalid = {
        teamId: 1,
        criteria: [20, value],
      } as unknown as SeasonRankingEntry;
      expect(() =>
        groupSeasonRankings([invalid, { teamId: 2, criteria: [10, 1] }]),
      ).toThrow(RangeError);
    },
  );

  it('requires explicit nulls for missing criteria in sparse arrays', () => {
    const criteria = Array<number | null>(3);
    criteria[0] = 10;
    criteria[2] = 20;
    expect(() => groupSeasonRankings([{ teamId: 1, criteria }])).toThrow(RangeError);
  });
});
