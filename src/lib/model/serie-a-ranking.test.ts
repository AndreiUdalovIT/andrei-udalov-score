import { describe, expect, it } from 'vitest';

import type { RoundRobinMatchScore } from './round-robin-season';
import { createSeededRandom } from './seeded-random';
import {
  createSeasonLotsSampler,
  SEASON_LOTS_SAMPLING_ALGORITHM,
  type SeasonLotGroup,
  type SimulatedSeasonLots,
} from './season-lots-sampler';
import { planSerieAPlayOffs, type SerieAPlayOffPlan } from './serie-a-play-off-plan';
import type { SerieAPlayOffLegResult } from './serie-a-play-off-result';
import {
  rankSerieASeason,
  SERIE_A_RANKING_ALGORITHM,
  type SerieAPlayOffOutcomeInput,
  type SerieASeasonRanking,
} from './serie-a-ranking';
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

function outcomesFor(plan: SerieAPlayOffPlan): SerieAPlayOffOutcomeInput[] {
  return plan.events.map((event) => {
    const higher = event.higherSlot.candidateTeamIds[0]!;
    const lower = event.lowerSlot.candidateTeamIds[0]!;
    return {
      kind: event.kind,
      legs:
        event.kind === 'title'
          ? [
              {
                leg: 1,
                homeTeamId: higher,
                awayTeamId: lower,
                homeGoals90: 0,
                awayGoals90: 1,
                source: 'simulated',
              },
            ]
          : [
              {
                leg: 1,
                homeTeamId: lower,
                awayTeamId: higher,
                homeGoals90: 1,
                awayGoals90: 0,
                source: 'simulated',
              },
              {
                leg: 2,
                homeTeamId: higher,
                awayTeamId: lower,
                homeGoals90: 0,
                awayGoals90: 0,
                source: 'simulated',
              },
            ],
    };
  });
}

function teamOrder(result: SerieASeasonRanking): number[] {
  return result.groups.map((group) => group.teamIds[0]);
}

function expectComplete(result: SerieASeasonRanking): void {
  const ids = Array.from({ length: 20 }, (_, index) => index + 1);
  expect(result.groups.map((group) => group.from)).toEqual(ids);
  expect(result.groups.map((group) => group.to)).toEqual(ids);
  expect(result.groups.every((group) => group.teamIds.length === 1)).toBe(true);
  expect([...teamOrder(result)].sort((left, right) => left - right)).toEqual(ids);
}

describe('complete Serie A season classification', () => {
  it.each([2023, 2024, 2025, 2026])(
    'returns a complete points table without requiring irrelevant finalist context in %s',
    (season) => {
      const scores = calendar();
      const result = rankSerieASeason(table(scores), scores, season)!;
      expect(SERIE_A_RANKING_ALGORITHM).toBe('sa-lots-and-play-offs-ranking-v1');
      expect(result.algorithm).toBe(SERIE_A_RANKING_ALGORITHM);
      expect(result.season).toBe(season);
      expect(result.scope).toBe('after-play-offs');
      expectComplete(result);
      expect(teamOrder(result)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      expect(result.groups.every((group) => group.reason === 'points')).toBe(true);
      expect(result.playOffPlan.events).toEqual([]);
      expect(result.playOffResults).toEqual([]);
      expect(result.qualificationNote).toBe(
        result.playOffPlan.preliminary.qualificationNote,
      );
    },
  );

  it('retains a mini-table decision for non-play-off places', () => {
    const scores = calendar([[4, 3, 0, 1]]);
    const result = rankSerieASeason(table(scores, [[3, 4]]), scores, 2026)!;
    expectComplete(result);
    expect(result.groups.slice(2, 4)).toEqual([
      { from: 3, to: 3, teamIds: [3], reason: 'classifica-avulsa' },
      { from: 4, to: 4, teamIds: [4], reason: 'classifica-avulsa' },
    ]);
  });

  it('requires and applies lots for non-play-off places too', () => {
    const scores = calendar();
    const rows = table(scores, [[8, 9, 10]]);
    expect(rankSerieASeason(rows, scores, 2026)).toBeNull();
    const draw = lots({ from: 8, to: 10, teamIds: [10, 8, 9] });
    const result = rankSerieASeason(rows, scores, 2026, null, draw)!;
    expectComplete(result);
    expect(result.groups.slice(7, 10).map((group) => group.teamIds[0])).toEqual([
      10, 8, 9,
    ]);
    expect(result.groups.slice(7, 10).map((group) => group.reason)).toEqual([
      'simulated-lots',
      'simulated-lots',
      'simulated-lots',
    ]);
    expect(result.playOffPlan.lots).toEqual(draw);
    expect(result.playOffResults).toEqual([]);
  });

  it('assigns both play-off outcomes while preserving the remaining positions and league statistics', () => {
    const scores = calendar();
    const rows = table(scores, [
      [1, 2],
      [17, 18],
    ]);
    const draw = lots(
      { from: 1, to: 2, teamIds: [1, 2] },
      { from: 17, to: 18, teamIds: [17, 18] },
    );
    const plan = planSerieAPlayOffs(rows, scores, 2026, [], draw)!;
    const inputs = outcomesFor(plan);
    const snapshot = JSON.stringify({ rows, scores, draw, inputs });
    const result = rankSerieASeason(rows, scores, 2026, [], draw, inputs)!;
    expectComplete(result);
    const expected = Array.from({ length: 20 }, (_, index) => index + 1);
    [expected[0], expected[1]] = [2, 1];
    [expected[16], expected[17]] = [18, 17];
    expect(teamOrder(result)).toEqual(expected);
    expect(result.groups.slice(0, 2).map((group) => group.reason)).toEqual([
      'title-play-off',
      'title-play-off',
    ]);
    expect(result.groups.slice(16, 18).map((group) => group.reason)).toEqual([
      'survival-play-off',
      'survival-play-off',
    ]);
    expect(result.playOffPlan).toEqual(plan);
    expect(result.playOffResults.map((item) => item.method)).toEqual([
      'regulation-goals',
      'aggregate-goals',
    ]);
    expect(JSON.stringify({ rows, scores, draw, inputs })).toBe(snapshot);
  });

  it('uses actual shootout winners when goals alone cannot assign the places', () => {
    const scores = calendar();
    const rows = table(scores, [
      [1, 2],
      [17, 18],
    ]);
    const draw = lots(
      { from: 1, to: 2, teamIds: [1, 2] },
      { from: 17, to: 18, teamIds: [17, 18] },
    );
    const inputs: SerieAPlayOffOutcomeInput[] = [
      {
        kind: 'title',
        legs: [
          {
            leg: 1,
            homeTeamId: 1,
            awayTeamId: 2,
            homeGoals90: 0,
            awayGoals90: 0,
            source: 'known-result',
          },
        ],
        shootout: { winnerTeamId: 2, source: 'known-result' },
      },
      {
        kind: 'survival',
        legs: [
          {
            leg: 1,
            homeTeamId: 18,
            awayTeamId: 17,
            homeGoals90: 0,
            awayGoals90: 1,
            source: 'known-result',
          },
          {
            leg: 2,
            homeTeamId: 17,
            awayTeamId: 18,
            homeGoals90: 1,
            awayGoals90: 2,
            source: 'simulated',
          },
        ],
        shootout: { winnerTeamId: 17, source: 'simulated' },
      },
    ];
    const result = rankSerieASeason(rows, scores, 2026, [], draw, inputs)!;
    expectComplete(result);
    expect(result.groups[0]!.teamIds).toEqual([2]);
    expect(result.groups[16]!.teamIds).toEqual([17]);
    expect(result.playOffResults.map((item) => item.method)).toEqual([
      'penalties',
      'penalties',
    ]);
    expect(result.playOffResults[1]!.legs.map((leg) => leg.source)).toEqual([
      'known-result',
      'simulated',
    ]);
  });

  it('does not require lots when sporting criteria already resolve the selected title pair', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [])!);
    const result = rankSerieASeason(rows, scores, 2026, [], null, inputs)!;
    expectComplete(result);
    expect(result.groups[0]!.teamIds).toEqual([2]);
    expect(result.groups[1]!.teamIds).toEqual([1]);
    expect(result.playOffPlan.lots).toBeNull();
  });

  it('keeps missing finalist context unavailable when a play-off decision needs it', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [])!);
    expect(rankSerieASeason(rows, scores, 2026, null, null, inputs)).toBeNull();
    expect(rankSerieASeason(rows, scores, 2026, [], null, inputs)).not.toBeNull();
  });

  it('applies a known UEFA waiver without requiring fabricated match results', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const result = rankSerieASeason(rows, scores, 2026, [2])!;
    expectComplete(result);
    expect(result.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'classifica-avulsa' },
      { from: 2, to: 2, teamIds: [2], reason: 'classifica-avulsa' },
    ]);
    expect(result.playOffResults[0]!.method).toBe('classifica-avulsa');
    expect(result.playOffResults[0]!.aggregateGoals90).toBeNull();
    expect(result.playOffResults[0]!.legs).toEqual([]);
  });

  it('retains simulated lot provenance when both waived events still depend on that order', () => {
    const scores = calendar();
    const rows = table(scores, [
      [1, 2],
      [17, 18],
    ]);
    const draw = lots(
      { from: 1, to: 2, teamIds: [2, 1] },
      { from: 17, to: 18, teamIds: [18, 17] },
    );
    const result = rankSerieASeason(rows, scores, 2026, [1, 17], draw)!;
    expectComplete(result);
    expect(result.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [2],
      reason: 'simulated-lots',
    });
    expect(result.groups[16]).toEqual({
      from: 17,
      to: 17,
      teamIds: [18],
      reason: 'simulated-lots',
    });
    expect(result.playOffResults.map((item) => item.method)).toEqual([
      'classifica-avulsa',
      'classifica-avulsa',
    ]);
    expect(result.playOffPlan.lots).toEqual(draw);
  });

  it('reuses one whole-league permutation across both events without duplicating clubs', () => {
    const scores = calendar();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const rows = table(scores, [ids]);
    const draw = lots({ from: 1, to: 20, teamIds: [...ids].reverse() });
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
    const result = rankSerieASeason(rows, scores, 2026, [], draw, inputs)!;
    expectComplete(result);
    const expected = [...ids].reverse();
    [expected[0], expected[1]] = [19, 20];
    [expected[16], expected[17]] = [3, 4];
    expect(teamOrder(result)).toEqual(expected);
    expect(result.playOffPlan.lots!.orders).toHaveLength(1);
    expect(result.playOffPlan.preliminary.groups[0]!.teamIds).toEqual(ids);
    expect(result.groups[2]!.reason).toBe('simulated-lots');
  });

  it('reproduces a seeded scenario after transport and reordering of every input collection', () => {
    const scores = calendar();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const rows = table(scores, [ids]);
    const preliminary = planSerieAPlayOffs(rows, scores, 2026, [])!.preliminary;
    const draw = createSeasonLotsSampler(preliminary.groups).sample(
      createSeededRandom([1, 2, 3, 4]),
    );
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
    const result = rankSerieASeason(rows, scores, 2026, [], draw, inputs)!;
    const transported: SerieAPlayOffOutcomeInput[] = JSON.parse(
      JSON.stringify(inputs),
    );
    transported.reverse();
    for (const input of transported) {
      (input.legs as SerieAPlayOffLegResult[]).reverse();
    }
    expect(
      rankSerieASeason(
        [...rows].reverse(),
        [...scores].reverse(),
        2026,
        [],
        JSON.parse(JSON.stringify(draw)),
        transported,
      ),
    ).toEqual(result);
    expectComplete(result);
  });

  it.each(['none', 'title', 'survival'] as const)(
    'waits until both required outcomes are complete: %s',
    (available) => {
      const scores = calendar();
      const rows = table(scores, [
        [1, 2],
        [17, 18],
      ]);
      const draw = lots(
        { from: 1, to: 2, teamIds: [1, 2] },
        { from: 17, to: 18, teamIds: [17, 18] },
      );
      const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
      const supplied = inputs.filter((item) => item.kind === available);
      expect(rankSerieASeason(rows, scores, 2026, [], draw, supplied)).toBeNull();
    },
  );

  it('waits for required penalties instead of assigning a tied title by seed', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const input: SerieAPlayOffOutcomeInput = {
      kind: 'title',
      legs: [
        {
          leg: 1,
          homeTeamId: 1,
          awayTeamId: 2,
          homeGoals90: 0,
          awayGoals90: 0,
          source: 'simulated',
        },
      ],
    };
    expect(rankSerieASeason(rows, scores, 2026, [], null, [input])).toBeNull();
  });

  it('keeps a non-play-off draw unavailable even after the title is resolved', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [
      [1, 2],
      [8, 9],
    ]);
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [])!);
    expect(rankSerieASeason(rows, scores, 2026, [], null, inputs)).toBeNull();
    const draw = lots({ from: 8, to: 9, teamIds: [9, 8] });
    expect(rankSerieASeason(rows, scores, 2026, [], draw, inputs)).not.toBeNull();
  });

  it.each([
    { kind: 'title', legs: [] },
    { kind: 'survival', legs: [] },
    { kind: 'other', legs: [] },
  ])('rejects outcome kinds without a planned event: %j', (input) => {
    const scores = calendar();
    expect(() =>
      rankSerieASeason(table(scores), scores, 2026, [], null, [
        input as SerieAPlayOffOutcomeInput,
      ]),
    ).toThrow(RangeError);
  });

  it('rejects an extra survival outcome when only the title event is planned', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    expect(() =>
      rankSerieASeason(rows, scores, 2026, [], null, [
        { kind: 'survival', legs: [] },
      ]),
    ).toThrow(RangeError);
  });

  it('rejects repeated and missing outcome elements', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [[1, 2]]);
    const input: SerieAPlayOffOutcomeInput = { kind: 'title', legs: [] };
    expect(() =>
      rankSerieASeason(rows, scores, 2026, [], null, [input, input]),
    ).toThrow(RangeError);
    expect(() =>
      rankSerieASeason(
        rows,
        scores,
        2026,
        [],
        null,
        Array<SerieAPlayOffOutcomeInput>(1),
      ),
    ).toThrow(RangeError);
  });

  it('still validates a later outcome when the earlier event is unresolved', () => {
    const scores = calendar();
    const rows = table(scores, [
      [1, 2],
      [17, 18],
    ]);
    const draw = lots(
      { from: 1, to: 2, teamIds: [1, 2] },
      { from: 17, to: 18, teamIds: [17, 18] },
    );
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
    const survival = inputs.find((item) => item.kind === 'survival')!;
    const invalid = {
      ...survival,
      legs: [{ ...survival.legs[0]!, homeGoals90: NaN }],
    };
    expect(() => rankSerieASeason(rows, scores, 2026, [], draw, [invalid])).toThrow(
      RangeError,
    );
  });

  it('still validates provided outcomes when a non-play-off draw is unresolved', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [
      [1, 2],
      [8, 9],
    ]);
    const input: SerieAPlayOffOutcomeInput = {
      kind: 'title',
      legs: [
        {
          leg: 1,
          homeTeamId: 2,
          awayTeamId: 1,
          homeGoals90: 1,
          awayGoals90: 0,
          source: 'simulated',
        },
      ],
    };
    expect(() => rankSerieASeason(rows, scores, 2026, [], null, [input])).toThrow(
      RangeError,
    );
  });

  it('delegates malformed lots and waived match results to the existing validators', () => {
    const scores = calendar();
    const rows = table(scores, [[1, 2]]);
    expect(() => rankSerieASeason(rows, scores, 2026, [], lots())).toThrow(
      RangeError,
    );
    const draw = lots({ from: 1, to: 2, teamIds: [1, 2] });
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
    expect(() => rankSerieASeason(rows, scores, 2026, [1], draw, inputs)).toThrow(
      RangeError,
    );
  });

  it('keeps preliminary availability and invalid-data behavior consistent with the planner', () => {
    const scores = calendar();
    const rows = table(scores);
    const extra: SerieAPlayOffOutcomeInput[] = [{ kind: 'title', legs: [] }];
    expect(
      rankSerieASeason(rows, scores.slice(1), 2026, [], null, extra),
    ).toBeNull();
    expect(rankSerieASeason([], [], 2027, [], null, extra)).toBeNull();
    expect(() => rankSerieASeason([], [], 2026.5)).toThrow(RangeError);
    expect(() =>
      rankSerieASeason(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
  });

  it('preserves frozen inputs and isolates the final groups from both audit branches', () => {
    const scores = Object.freeze(calendar().map((score) => Object.freeze(score)));
    const rows = Object.freeze(
      table(scores, [
        [1, 2],
        [17, 18],
      ]).map((row) => Object.freeze(row)),
    );
    const draw = lots(
      { from: 1, to: 2, teamIds: [1, 2] },
      { from: 17, to: 18, teamIds: [17, 18] },
    );
    for (const order of draw.orders) {
      Object.freeze(order.teamIds);
      Object.freeze(order);
    }
    Object.freeze(draw.orders);
    Object.freeze(draw);
    const inputs = outcomesFor(planSerieAPlayOffs(rows, scores, 2026, [], draw)!);
    for (const input of inputs) {
      for (const leg of input.legs) Object.freeze(leg);
      Object.freeze(input.legs);
      Object.freeze(input);
    }
    Object.freeze(inputs);
    const finalists = Object.freeze([] as number[]);
    const expected = rankSerieASeason(rows, scores, 2026, finalists, draw, inputs)!;
    const result = rankSerieASeason(rows, scores, 2026, finalists, draw, inputs)!;
    expectComplete(result);
    result.groups[0]!.teamIds[0] = 999;
    expect(result.playOffResults[0]!.placements[0]!.teamId).toBe(2);
    expect(result.playOffPlan.lots!.orders[0]!.teamIds).toEqual([1, 2]);
    result.playOffPlan.lots!.orders[0]!.teamIds.push(777);
    expect(result.groups[1]!.teamIds).toEqual([1]);
    result.playOffResults[1]!.placements[0]!.teamId = 666;
    expect(result.groups[16]!.teamIds).toEqual([18]);
    expect(draw.orders[0]!.teamIds).toEqual([1, 2]);
    expect(rankSerieASeason(rows, scores, 2026, finalists, draw, inputs)).toEqual(
      expected,
    );
  });
});
