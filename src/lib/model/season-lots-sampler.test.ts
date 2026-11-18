import { describe, expect, it, vi } from 'vitest';

import { createSeededRandom } from './seeded-random';
import {
  createSeasonLotsSampler,
  SEASON_LOTS_SAMPLING_ALGORITHM,
} from './season-lots-sampler';
import { planSerieAPlayOffs } from './serie-a-play-off-plan';
import { projectSeasonStats } from './season-stats';

const scale = 2 ** 53;
const triple = { from: 1, to: 3, teamIds: [1, 2, 3] };

function numerators(...values: number[]) {
  let index = 0;
  return vi.fn(() => {
    if (index >= values.length) throw new Error('unexpected additional random draw');
    return values[index++]! / scale;
  });
}

describe('reproducible season lot sampling', () => {
  it('returns an explicitly simulated empty result without consuming randomness', () => {
    expect(SEASON_LOTS_SAMPLING_ALGORITHM).toBe(
      'position-ordered-fisher-yates-u53-rejection128-v1',
    );
    const random = vi.fn(() => {
      throw new Error('no random draw expected');
    });
    const sampler = createSeasonLotsSampler([]);
    expect(sampler.algorithm).toBe(SEASON_LOTS_SAMPLING_ALGORITHM);
    expect(sampler.groupCount).toBe(0);
    expect(sampler.minimumRandomDraws).toBe(0);
    expect(sampler.sample(random)).toEqual({
      algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
      source: 'simulated-lots',
      randomDraws: 0,
      orders: [],
    });
    expect(random).not.toHaveBeenCalled();
  });

  it('matches a permutation derived from independently checked C-reference numerators', () => {
    // First four C-reference numerators give bounded choices 0, 2, 1, 0.
    const random = createSeededRandom([1, 2, 3, 4]);
    const sampler = createSeasonLotsSampler([
      { from: 1, to: 5, teamIds: [5, 3, 1, 4, 2] },
    ]);
    expect(sampler.groupCount).toBe(1);
    expect(sampler.minimumRandomDraws).toBe(4);
    expect(sampler.sample(random)).toEqual({
      algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
      source: 'simulated-lots',
      randomDraws: 4,
      orders: [{ from: 1, to: 5, teamIds: [4, 5, 2, 3, 1] }],
    });
    expect(random() * scale).toBe(7820490797693033);
  });

  it('produces all six three-club orders once over the bounded-choice combinations', () => {
    const sampler = createSeasonLotsSampler([triple]);
    const results: string[] = [];
    for (let first = 0; first < 3; first += 1) {
      for (let second = 0; second < 2; second += 1) {
        const random = numerators(first, second);
        const result = sampler.sample(random);
        expect(result.randomDraws).toBe(2);
        expect(random).toHaveBeenCalledTimes(2);
        results.push(result.orders[0]!.teamIds.join(','));
      }
    }
    expect(results.sort()).toEqual([
      '1,2,3',
      '1,3,2',
      '2,1,3',
      '2,3,1',
      '3,1,2',
      '3,2,1',
    ]);
  });

  it('rejects both excess numerators for a three-way choice before using an accepted one', () => {
    const random = numerators(scale - 1, scale - 2, 0, 0);
    const sampler = createSeasonLotsSampler([triple]);
    expect(sampler.minimumRandomDraws).toBe(2);
    const result = sampler.sample(random);
    expect(result.orders).toEqual([{ from: 1, to: 3, teamIds: [2, 3, 1] }]);
    expect(result.randomDraws).toBe(4);
    expect(random).toHaveBeenCalledTimes(4);
  });

  it('accepts the numerator immediately below the rejection limit', () => {
    const result = createSeasonLotsSampler([triple]).sample(
      numerators(scale - 3, 0),
    );
    expect(result.randomDraws).toBe(2);
    expect(result.orders[0]!.teamIds).toEqual([2, 1, 3]);
  });

  it.each([
    { value: 0, order: [2, 1] },
    { value: 1 - 1 / scale, order: [1, 2] },
  ])(
    'supports the random boundary $value for a two-club choice',
    ({ value, order }) => {
      const random = vi.fn(() => value);
      const result = createSeasonLotsSampler([
        { from: 8, to: 9, teamIds: [2, 1] },
      ]).sample(random);
      expect(result.orders).toEqual([{ from: 8, to: 9, teamIds: order }]);
      expect(result.randomDraws).toBe(1);
      expect(random).toHaveBeenCalledTimes(1);
    },
  );

  it('processes groups by position and members by team ID while retaining range gaps', () => {
    const sampler = createSeasonLotsSampler([
      { from: 10, to: 12, teamIds: [6, 4, 5] },
      { from: 1, to: 3, teamIds: [3, 1, 2] },
    ]);
    expect(sampler.groupCount).toBe(2);
    expect(sampler.minimumRandomDraws).toBe(4);
    expect(sampler.sample(numerators(0, 0, 1, 1)).orders).toEqual([
      { from: 1, to: 3, teamIds: [2, 3, 1] },
      { from: 10, to: 12, teamIds: [4, 6, 5] },
    ]);
  });

  it('reproduces seeded samples after transport and input permutation', () => {
    const groups = [
      { from: 10, to: 12, teamIds: [6, 4, 5] },
      { from: 1, to: 3, teamIds: [3, 1, 2] },
    ];
    const seed = [123, 456, 789, 101112] as const;
    const first = createSeasonLotsSampler(groups).sample(createSeededRandom(seed));
    const transported = JSON.parse(JSON.stringify(groups)) as typeof groups;
    const permuted = transported.reverse().map((group) => ({
      ...group,
      teamIds: [...group.teamIds].reverse(),
    }));
    expect(
      createSeasonLotsSampler(permuted).sample(createSeededRandom(seed)),
    ).toEqual(first);
  });

  it('copies preparation inputs and returns independent results on repeated samples', () => {
    const groups = [{ from: 1, to: 3, teamIds: [3, 1, 2] }];
    const sampler = createSeasonLotsSampler(groups);
    groups[0]!.from = 10;
    groups[0]!.to = 12;
    groups[0]!.teamIds.fill(999);
    const expected = {
      algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
      source: 'simulated-lots',
      randomDraws: 2,
      orders: [{ from: 1, to: 3, teamIds: [2, 3, 1] }],
    };
    const first = sampler.sample(() => 0);
    const second = sampler.sample(() => 0);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    first.orders[0]!.teamIds.push(999);
    first.orders[0]!.from = 20;
    expect(second).toEqual(expected);
    expect(sampler.sample(() => 0)).toEqual(expected);
  });

  it('preserves fully frozen preparation inputs', () => {
    const groups = Object.freeze([
      Object.freeze({ from: 1, to: 3, teamIds: Object.freeze([3, 2, 1]) }),
    ]);
    expect(
      createSeasonLotsSampler(groups).sample(() => 0).orders[0]!.teamIds,
    ).toEqual([2, 3, 1]);
    expect(groups[0]!.teamIds).toEqual([3, 2, 1]);
  });

  it.each([
    { from: 0, to: 1, teamIds: [1, 2] },
    { from: -1, to: 0, teamIds: [1, 2] },
    { from: 1.5, to: 2.5, teamIds: [1, 2] },
    { from: 1, to: 3, teamIds: [1, 2] },
    { from: 2, to: 1, teamIds: [1, 2] },
    { from: 1, to: 1, teamIds: [1] },
    { from: 1, to: 0, teamIds: [] },
    { from: Infinity, to: Infinity, teamIds: [1, 2] },
    { from: 1, to: Infinity, teamIds: [1, 2] },
    { from: Number.MAX_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER, teamIds: [1, 2] },
  ])('rejects invalid position ranges: %j', (group) => {
    expect(() => createSeasonLotsSampler([group])).toThrow(RangeError);
  });

  it('accepts a range whose inclusive end is the largest safe integer', () => {
    const result = createSeasonLotsSampler([
      {
        from: Number.MAX_SAFE_INTEGER - 1,
        to: Number.MAX_SAFE_INTEGER,
        teamIds: [1, 2],
      },
    ]).sample(() => 0);
    expect(result.orders).toEqual([
      {
        from: Number.MAX_SAFE_INTEGER - 1,
        to: Number.MAX_SAFE_INTEGER,
        teamIds: [2, 1],
      },
    ]);
  });

  it('rejects overlapping position ranges even when their clubs are disjoint', () => {
    expect(() =>
      createSeasonLotsSampler([
        { from: 1, to: 3, teamIds: [1, 2, 3] },
        { from: 3, to: 4, teamIds: [4, 5] },
      ]),
    ).toThrow(RangeError);
  });

  it('accepts adjacent disjoint groups', () => {
    const result = createSeasonLotsSampler([
      { from: 1, to: 2, teamIds: [1, 2] },
      { from: 3, to: 4, teamIds: [3, 4] },
    ]).sample(() => 0);
    expect(result.orders).toEqual([
      { from: 1, to: 2, teamIds: [2, 1] },
      { from: 3, to: 4, teamIds: [4, 3] },
    ]);
  });

  it.each([
    { ids: [1, 1] },
    { ids: [0, 1] },
    { ids: [-1, 1] },
    { ids: [1.5, 2] },
    { ids: [NaN, 2] },
    { ids: [Infinity, 2] },
    { ids: [Number.MAX_SAFE_INTEGER + 1, 2] },
    { ids: Array<number>(2) },
  ])('rejects invalid or repeated team IDs: %j', ({ ids }) => {
    expect(() =>
      createSeasonLotsSampler([{ from: 1, to: 2, teamIds: ids }]),
    ).toThrow(RangeError);
  });

  it('rejects clubs repeated across separate draw groups', () => {
    expect(() =>
      createSeasonLotsSampler([
        { from: 1, to: 2, teamIds: [1, 2] },
        { from: 10, to: 11, teamIds: [2, 3] },
      ]),
    ).toThrow(RangeError);
  });

  it.each([-1, 1, NaN, Infinity, -Infinity, 2 ** -54])(
    'rejects random values outside the 53-bit fraction contract: %s',
    (value) => {
      const random = vi.fn(() => value);
      expect(() => createSeasonLotsSampler([triple]).sample(random)).toThrow(
        RangeError,
      );
      expect(random).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds rejection attempts and remains reusable after a failed sample', () => {
    const sampler = createSeasonLotsSampler([triple]);
    const random = vi.fn(() => 1 - 1 / scale);
    expect(() => sampler.sample(random)).toThrow(/rejection limit/);
    expect(random).toHaveBeenCalledTimes(128);
    expect(sampler.sample(() => 0).orders[0]!.teamIds).toEqual([2, 3, 1]);
  });

  it('uses one permutation for all shared Serie A title and survival positions', () => {
    const teamIds = Array.from({ length: 20 }, (_, index) => index + 1);
    const scores = teamIds.flatMap((homeTeamId) =>
      teamIds
        .filter((awayTeamId) => awayTeamId !== homeTeamId)
        .map((awayTeamId) => ({
          id: (homeTeamId - 1) * 20 + awayTeamId,
          homeTeamId,
          awayTeamId,
          source: 'simulated' as const,
          homeGoals90: 1,
          awayGoals90: 0,
        })),
    );
    const empty = teamIds.map((teamId) => ({
      teamId,
      playedGames: 0,
      won: 0,
      draw: 0,
      lost: 0,
      points: 0,
      goalsFor: 0,
      goalsAgainst: 0,
    }));
    const rows = projectSeasonStats(empty, scores)!.map((row) => ({
      ...row,
      points: 0,
    }));
    const plan = planSerieAPlayOffs(rows, scores, 2026, [])!;
    expect(plan.events).toHaveLength(2);
    const eligible = plan.preliminary.groups.filter(
      (group) => group.reason === 'drawing-of-lots-required',
    );
    const sampler = createSeasonLotsSampler(eligible);
    expect(sampler.groupCount).toBe(1);
    expect(sampler.minimumRandomDraws).toBe(19);
    const sample = sampler.sample(createSeededRandom([123, 456, 789, 101112]));
    expect(sample.source).toBe('simulated-lots');
    expect(sample.randomDraws).toBe(19);
    expect(sample.orders).toHaveLength(1);
    const order = sample.orders[0]!;
    expect([...order.teamIds].sort((left, right) => left - right)).toEqual(teamIds);
    const teamAt = (position: number) => order.teamIds[position - order.from]!;
    const participants = plan.events.flatMap((event) => [
      teamAt(event.higherSlot.position),
      teamAt(event.lowerSlot.position),
    ]);
    expect(new Set(participants).size).toBe(4);
  });
});
