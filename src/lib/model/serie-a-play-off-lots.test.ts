import { describe, expect, it } from 'vitest';

import type { RoundRobinMatchScore } from './round-robin-season';
import { createSeededRandom } from './seeded-random';
import {
  createSeasonLotsSampler,
  SEASON_LOTS_SAMPLING_ALGORITHM,
  type SeasonLotGroup,
  type SimulatedSeasonLots,
} from './season-lots-sampler';
import {
  planSerieAPlayOffs,
  type SerieAPlayOffLotsInput,
} from './serie-a-play-off-plan';
import { projectSeasonStats, type SeasonStatsBaseline } from './season-stats';

type Override = readonly [
  home: number,
  away: number,
  homeGoals: number,
  awayGoals: number,
];

function calendar(overrides: readonly Override[] = []): RoundRobinMatchScore[] {
  const changed = new Map(
    overrides.map(([home, away, homeGoals90, awayGoals90]) => [
      `${home}:${away}`,
      { homeGoals90, awayGoals90 },
    ]),
  );
  const scores: RoundRobinMatchScore[] = [];
  for (let homeTeamId = 1; homeTeamId <= 20; homeTeamId += 1) {
    for (let awayTeamId = 1; awayTeamId <= 20; awayTeamId += 1) {
      if (homeTeamId === awayTeamId) continue;
      scores.push({
        id: scores.length + 1,
        homeTeamId,
        awayTeamId,
        ...(changed.get(`${homeTeamId}:${awayTeamId}`) ?? {
          homeGoals90: 1,
          awayGoals90: 0,
        }),
      });
    }
  }
  return scores;
}

function table(
  scores: readonly Readonly<RoundRobinMatchScore>[],
  ties: readonly (readonly number[])[] = [],
): SeasonStatsBaseline[] {
  const rows = projectSeasonStats(
    Array.from({ length: 20 }, (_, index) => ({
      teamId: index + 1,
      playedGames: 0,
      won: 0,
      draw: 0,
      lost: 0,
      points: 0,
      goalsFor: 0,
      goalsAgainst: 0,
    })),
    scores.map((score) => ({ ...score, source: 'simulated' as const })),
  )!;
  const adjustedPoints = new Map<number, number>();
  for (const ids of ties) {
    for (const id of ids) adjustedPoints.set(id, -Math.min(...ids));
  }
  // Synthetic official deductions isolate the relevant point groups.
  return rows.map((row) => ({
    ...row,
    points: adjustedPoints.get(row.teamId) ?? -row.teamId,
  }));
}

function lots(...orders: SeasonLotGroup[]): SimulatedSeasonLots {
  return {
    algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
    source: 'simulated-lots',
    randomDraws: orders.reduce((sum, order) => sum + order.teamIds.length - 1, 0),
    orders: orders.map((order) => ({ ...order, teamIds: [...order.teamIds] })),
  };
}

describe('applying simulated lots to Serie A play-off plans', () => {
  it('keeps omitted and explicit null lots equivalent', () => {
    const scores = calendar();
    const rows = table(scores, [[1, 2, 3]]);
    const result = planSerieAPlayOffs(rows, scores, 2026, [])!;
    expect(planSerieAPlayOffs(rows, scores, 2026, [], null)).toEqual(result);
    expect(result.lots).toBeNull();
    expect(result.events[0]!.selection).toBe('participants-need-draw');
  });

  it('retains an explicit empty simulated result without creating events', () => {
    const scores = calendar();
    const draw = lots();
    const result = planSerieAPlayOffs(table(scores), scores, 2026, [], draw)!;
    expect(result.lots).toEqual(draw);
    expect(result.lots).not.toBe(draw);
    expect(result.events).toEqual([]);
  });

  it('accepts empty lots when sporting criteria already determine a required pair', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const unresolved = planSerieAPlayOffs(rows, scores, 2026, [])!;
    const result = planSerieAPlayOffs(rows, scores, 2026, [], lots())!;
    expect(result.events).toEqual(unresolved.events);
    expect(result.events[0]!.selection).toBe('ordered-pair-known');
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([1]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([2]);
    expect(result.lots!.orders).toEqual([]);
  });

  it('retains actual random consumption including sampler rejections', () => {
    const scores = calendar();
    const rows = table(scores, [[1, 2, 3]]);
    const sampler = createSeasonLotsSampler([
      { from: 1, to: 3, teamIds: [1, 2, 3] },
    ]);
    const values = [1 - 1 / 2 ** 53, 0, 0];
    const draw = sampler.sample(() => {
      if (values.length === 0) throw new Error('unexpected random draw');
      return values.shift()!;
    });
    expect(draw.randomDraws).toBe(3);
    const result = planSerieAPlayOffs(rows, scores, 2026, [], draw)!;
    expect(result.lots).toEqual(draw);
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([2]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([3]);
  });

  it.each([
    { finalists: [], decision: 'play-off-required' },
    { finalists: [1], decision: 'classifica-avulsa-applies' },
    { finalists: [2], decision: 'play-off-required' },
    { finalists: null, decision: 'uefa-finalists-required' },
  ])(
    're-evaluates the title exception for the selected pair: %j',
    ({ finalists, decision }) => {
      const scores = calendar();
      const rows = table(scores, [[1, 2, 3]]);
      const result = planSerieAPlayOffs(
        rows,
        scores,
        2026,
        finalists,
        lots({ from: 1, to: 3, teamIds: [3, 1, 2] }),
      )!;
      const event = result.events[0]!;
      expect(event.higherSlot).toEqual({ position: 1, candidateTeamIds: [3] });
      expect(event.lowerSlot).toEqual({ position: 2, candidateTeamIds: [1] });
      expect(event.selection).toBe('ordered-pair-known');
      expect(event.decision).toBe(decision);
      expect(event.pointsGroupTeamIds).toEqual([1, 2, 3]);
      expect(result.preliminary).toEqual(
        planSerieAPlayOffs(rows, scores, 2026, finalists)!.preliminary,
      );
      expect(result.lots!.source).toBe('simulated-lots');
    },
  );

  it.each([
    { finalists: [2], decision: 'play-off-required' },
    { finalists: [3], decision: 'classifica-avulsa-applies' },
  ])(
    'combines a fixed upper club with a drawn lower club: %j',
    ({ finalists, decision }) => {
      const scores = calendar([
        [2, 1, 0, 1],
        [3, 1, 0, 1],
      ]);
      const result = planSerieAPlayOffs(
        table(scores, [[1, 2, 3]]),
        scores,
        2026,
        finalists,
        lots({ from: 2, to: 3, teamIds: [3, 2] }),
      )!;
      expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([1]);
      expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([3]);
      expect(result.events[0]!.decision).toBe(decision);
    },
  );

  it.each([
    { finalists: [16], decision: 'play-off-required' },
    { finalists: [17], decision: 'classifica-avulsa-applies' },
  ])(
    'selects survival clubs across separate unresolved groups: %j',
    ({ finalists, decision }) => {
      const scores = calendar([
        [18, 16, 0, 1],
        [19, 16, 0, 1],
        [18, 17, 0, 1],
        [19, 17, 0, 1],
      ]);
      const input = lots(
        { from: 18, to: 19, teamIds: [19, 18] },
        { from: 16, to: 17, teamIds: [16, 17] },
      );
      const result = planSerieAPlayOffs(
        table(scores, [[16, 17, 18, 19]]),
        scores,
        2026,
        finalists,
        input,
      )!;
      const event = result.events[0]!;
      expect(event.higherSlot).toEqual({ position: 17, candidateTeamIds: [17] });
      expect(event.lowerSlot).toEqual({ position: 18, candidateTeamIds: [19] });
      expect(event.selection).toBe('ordered-pair-known');
      expect(event.decision).toBe(decision);
      expect(result.lots!.orders.map((order) => order.from)).toEqual([16, 18]);
      expect(input.orders.map((order) => order.from)).toEqual([18, 16]);
    },
  );

  it('resolves hosts from the same order used for selecting each pair', () => {
    const scores = calendar();
    const result = planSerieAPlayOffs(
      table(scores, [
        [1, 2],
        [17, 18],
      ]),
      scores,
      2026,
      [],
      lots(
        { from: 1, to: 2, teamIds: [2, 1] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ),
    )!;
    const [title, survival] = result.events;
    expect(title!.higherSlot.candidateTeamIds).toEqual([2]);
    expect(title!.normalFormat.firstLegHomeSlot).toBe('higher');
    expect(survival!.higherSlot.candidateTeamIds).toEqual([18]);
    expect(survival!.lowerSlot.candidateTeamIds).toEqual([17]);
    expect(survival!.normalFormat.firstLegHomeSlot).toBe('lower');
    expect(survival!.normalFormat.secondLegHomeSlot).toBe('higher');
  });

  it.each([2023, 2024, 2025])(
    'preserves the legacy rules after resolving lots in %s',
    (season) => {
      const scores = calendar();
      const result = planSerieAPlayOffs(
        table(scores, [[1, 2]]),
        scores,
        season,
        [1],
        lots({ from: 1, to: 2, teamIds: [2, 1] }),
      )!;
      expect(result.events[0]!.selection).toBe('ordered-pair-known');
      expect(result.events[0]!.decision).toBe('play-off-required');
      expect(result.events[0]!.normalFormat.neutralVenueAlternative).toBe(
        'coppa-italia-final-venue',
      );
    },
  );

  it.each([
    {
      finalists: [20],
      decisions: ['classifica-avulsa-applies', 'play-off-required'],
    },
    {
      finalists: [3],
      decisions: ['play-off-required', 'classifica-avulsa-applies'],
    },
    { finalists: [1], decisions: ['play-off-required', 'play-off-required'] },
    {
      finalists: [20, 3],
      decisions: ['classifica-avulsa-applies', 'classifica-avulsa-applies'],
    },
  ])(
    'applies one shared permutation and per-event exceptions across the entire league: %j',
    ({ finalists, decisions }) => {
      const scores = calendar();
      const ids = Array.from({ length: 20 }, (_, index) => index + 1);
      const result = planSerieAPlayOffs(
        table(scores, [ids]),
        scores,
        2026,
        finalists,
        lots({ from: 1, to: 20, teamIds: [...ids].reverse() }),
      )!;
      expect(
        result.events.map((event) => event.higherSlot.candidateTeamIds),
      ).toEqual([[20], [4]]);
      expect(result.events.map((event) => event.lowerSlot.candidateTeamIds)).toEqual(
        [[19], [3]],
      );
      expect(result.events.map((event) => event.selection)).toEqual([
        'ordered-pair-known',
        'ordered-pair-known',
      ]);
      expect(result.events.map((event) => event.decision)).toEqual(decisions);
      expect(result.preliminary.groups).toHaveLength(1);
      expect(result.preliminary.groups[0]!.teamIds).toEqual(ids);
      expect(result.lots!.orders).toHaveLength(1);
    },
  );

  it('accepts the existing seeded sampler output and reproduces after input transport', () => {
    const scores = calendar();
    const rows = table(scores, [
      [1, 2, 3],
      [17, 18, 19],
    ]);
    const preliminary = planSerieAPlayOffs(rows, scores, 2026, [])!.preliminary;
    const sampler = createSeasonLotsSampler(
      preliminary.groups.filter(
        (group) => group.reason === 'drawing-of-lots-required',
      ),
    );
    const draw = sampler.sample(createSeededRandom([1, 2, 3, 4]));
    const result = planSerieAPlayOffs(rows, scores, 2026, [], draw)!;
    const transported: SimulatedSeasonLots = JSON.parse(JSON.stringify(draw));
    transported.orders.reverse();
    expect(
      planSerieAPlayOffs(
        [...rows].reverse(),
        [...scores].reverse(),
        2026,
        [],
        transported,
      ),
    ).toEqual(result);
    expect(result.lots).toEqual(draw);
    for (const event of result.events) {
      expect(event.selection).toBe('ordered-pair-known');
      const order = draw.orders.find(
        (item) =>
          item.from <= event.higherSlot.position &&
          event.lowerSlot.position <= item.to,
      )!;
      expect(event.higherSlot.candidateTeamIds).toEqual([
        order.teamIds[event.higherSlot.position - order.from],
      ]);
      expect(event.lowerSlot.candidateTeamIds).toEqual([
        order.teamIds[event.lowerSlot.position - order.from],
      ]);
    }
  });

  it('requires and retains complete lots for non-play-off groups too', () => {
    const scores = calendar();
    const rows = table(scores, [[8, 9]]);
    const draw = lots({ from: 8, to: 9, teamIds: [9, 8] });
    const result = planSerieAPlayOffs(rows, scores, 2026, [], draw)!;
    expect(result.events).toEqual([]);
    expect(result.lots).toEqual(draw);
    expect(result.preliminary.groups.find((group) => group.from === 8)!.reason).toBe(
      'drawing-of-lots-required',
    );
    expect(() => planSerieAPlayOffs(rows, scores, 2026, [], lots())).toThrow(
      RangeError,
    );
  });

  it.each([
    { name: 'unknown algorithm', patch: { algorithm: 'unknown-v1' } },
    { name: 'official provenance', patch: { source: 'official-lots' } },
    { name: 'negative count', patch: { randomDraws: -1 } },
    { name: 'fractional count', patch: { randomDraws: 3.5 } },
    { name: 'non-finite count', patch: { randomDraws: Infinity } },
    { name: 'NaN count', patch: { randomDraws: NaN } },
    { name: 'unsafe count', patch: { randomDraws: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'insufficient count', patch: { randomDraws: 2 } },
  ])('rejects invalid simulated provenance or draw metadata: $name', ({ patch }) => {
    const scores = calendar();
    const draw = lots(
      { from: 1, to: 3, teamIds: [3, 1, 2] },
      { from: 17, to: 18, teamIds: [18, 17] },
    );
    const invalid = { ...draw, ...patch } as SerieAPlayOffLotsInput;
    expect(() =>
      planSerieAPlayOffs(
        table(scores, [
          [1, 2, 3],
          [17, 18],
        ]),
        scores,
        2026,
        [],
        invalid,
      ),
    ).toThrow(RangeError);
  });

  it.each([
    { name: 'sparse group list', orders: Array<SeasonLotGroup>(2) },
    { name: 'missing group', orders: [{ from: 1, to: 3, teamIds: [3, 1, 2] }] },
    {
      name: 'extra group',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, 2] },
        { from: 17, to: 18, teamIds: [18, 17] },
        { from: 10, to: 11, teamIds: [10, 11] },
      ],
    },
    {
      name: 'repeated group',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, 2] },
        { from: 1, to: 3, teamIds: [2, 1, 3] },
      ],
    },
    {
      name: 'wrong start',
      orders: [
        { from: 2, to: 4, teamIds: [3, 1, 2] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'wrong end',
      orders: [
        { from: 1, to: 4, teamIds: [3, 1, 2] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'partial order',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'repeated club',
      orders: [
        { from: 1, to: 3, teamIds: [1, 1, 2] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'foreign club',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, 99] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'club from another group',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, 17] },
        { from: 17, to: 18, teamIds: [18, 2] },
      ],
    },
    {
      name: 'fractional club',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, 1.5] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'NaN club',
      orders: [
        { from: 1, to: 3, teamIds: [3, 1, NaN] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'sparse club list',
      orders: [
        { from: 1, to: 3, teamIds: Array<number>(3) },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
    {
      name: 'resolved group',
      orders: [
        { from: 10, to: 12, teamIds: [10, 11, 12] },
        { from: 17, to: 18, teamIds: [18, 17] },
      ],
    },
  ])(
    'rejects permutations that do not exactly match the original unresolved groups: $name',
    ({ orders }) => {
      const scores = calendar();
      const rows = table(scores, [
        [1, 2, 3],
        [17, 18],
      ]);
      const draw: SerieAPlayOffLotsInput = {
        algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
        source: 'simulated-lots',
        randomDraws: 4,
        orders,
      };
      expect(() => planSerieAPlayOffs(rows, scores, 2026, [], draw)).toThrow(
        RangeError,
      );
    },
  );

  it('rejects claimed random draws when there are no eligible groups', () => {
    const scores = calendar();
    expect(() =>
      planSerieAPlayOffs(table(scores), scores, 2026, [], {
        ...lots(),
        randomDraws: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      planSerieAPlayOffs(
        table(scores),
        scores,
        2026,
        [],
        lots({ from: 1, to: 2, teamIds: [2, 1] }),
      ),
    ).toThrow(RangeError);
  });

  it('validates supplied lots in legacy seasons too', () => {
    const scores = calendar();
    expect(() =>
      planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2025, [], lots()),
    ).toThrow(RangeError);
  });

  it('returns null when the underlying season is unavailable even with supplied lots', () => {
    const scores = calendar();
    const draw = lots({ from: 1, to: 2, teamIds: [2, 1] });
    expect(
      planSerieAPlayOffs(table(scores, [[1, 2]]), scores.slice(1), 2026, [], draw),
    ).toBeNull();
    expect(planSerieAPlayOffs([], [], 2027, [], lots())).toBeNull();
  });

  it('preserves deeply frozen inputs and isolates lot orders, candidates and original groups', () => {
    const scores = Object.freeze(calendar().map((score) => Object.freeze(score)));
    const rows = Object.freeze(
      table(scores, [
        [1, 2],
        [17, 18],
      ]).map((row) => Object.freeze(row)),
    );
    const finalists = Object.freeze([2]);
    const draw: SerieAPlayOffLotsInput = Object.freeze({
      algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
      source: 'simulated-lots',
      randomDraws: 2,
      orders: Object.freeze([
        Object.freeze({ from: 17, to: 18, teamIds: Object.freeze([18, 17]) }),
        Object.freeze({ from: 1, to: 2, teamIds: Object.freeze([2, 1]) }),
      ]),
    });
    const expected = planSerieAPlayOffs(rows, scores, 2026, finalists, draw)!;
    const result = planSerieAPlayOffs(rows, scores, 2026, finalists, draw)!;
    result.lots!.orders[0]!.teamIds.push(999);
    result.lots!.orders[0]!.from = 99;
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([2]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([1]);
    expect(result.preliminary.groups[0]!.teamIds).toEqual([1, 2]);
    result.events[1]!.higherSlot.candidateTeamIds.push(888);
    expect(result.lots!.orders[1]!.teamIds).toEqual([18, 17]);
    expect(draw.orders[1]!.teamIds).toEqual([2, 1]);
    expect(planSerieAPlayOffs(rows, scores, 2026, finalists, draw)).toEqual(
      expected,
    );
  });
});
