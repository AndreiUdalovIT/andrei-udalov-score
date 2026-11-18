import { describe, expect, it } from 'vitest';

import type { RoundRobinMatchScore } from './round-robin-season';
import {
  planSerieAPlayOffs,
  SERIE_A_PLAY_OFF_PLAN_ALGORITHM,
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

function winningCycle(a: number, b: number, c: number): Override[] {
  return [
    [b, a, 0, 1],
    [a, c, 0, 1],
    [c, b, 0, 1],
  ];
}

describe('Serie A play-off planning', () => {
  it.each([2023, 2024, 2025, 2026])(
    'returns no event without a relevant points tie in season %s',
    (season) => {
      const scores = calendar();
      const result = planSerieAPlayOffs(table(scores), scores, season)!;
      expect(result.algorithm).toBe(SERIE_A_PLAY_OFF_PLAN_ALGORITHM);
      expect(result.scope).toBe('play-off-plan');
      expect(result.season).toBe(season);
      expect(result.uefaFinalistTeamIds).toBeNull();
      expect(result.preliminary.scope).toBe('before-play-offs');
      expect(result.preliminary.groups).toHaveLength(20);
      expect(result.events).toEqual([]);
    },
  );

  it.each([2023, 2024, 2025])(
    'plans a legacy title game with the prescribed venue alternative in %s',
    (season) => {
      const scores = calendar(winningCycle(1, 2, 3));
      const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, season)!;
      expect(result.events).toEqual([
        {
          kind: 'title',
          points: -1,
          pointsGroupTeamIds: [1, 2],
          higherSlot: { position: 1, candidateTeamIds: [1] },
          lowerSlot: { position: 2, candidateTeamIds: [2] },
          selection: 'ordered-pair-known',
          decision: 'play-off-required',
          normalFormat: {
            legs: 1,
            firstLegHomeSlot: 'higher',
            secondLegHomeSlot: null,
            neutralVenueAlternative: 'coppa-italia-final-venue',
            extraTime: false,
            awayGoals: false,
            penaltiesOnTie: true,
          },
        },
      ]);
    },
  );

  it('uses the 2026 title format with an explicit empty finalist list', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026, [])!;
    expect(result.events[0]!.decision).toBe('play-off-required');
    expect(result.uefaFinalistTeamIds).toEqual([]);
    expect(result.events[0]!.normalFormat).toEqual({
      legs: 1,
      firstLegHomeSlot: 'higher',
      secondLegHomeSlot: null,
      neutralVenueAlternative: null,
      extraTime: false,
      awayGoals: false,
      penaltiesOnTie: true,
    });
  });

  it('keeps unknown 2026 finalist context distinct from an empty list', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026)!;
    expect(result.events[0]!.selection).toBe('ordered-pair-known');
    expect(result.events[0]!.decision).toBe('uefa-finalists-required');
    expect(result.uefaFinalistTeamIds).toBeNull();
  });

  it('applies classifica avulsa when an actual 2026 participant is a finalist', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026, [1])!;
    expect(result.events[0]!.decision).toBe('classifica-avulsa-applies');
  });

  it('does not waive a play-off because an unrelated club is a finalist', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026, [3])!;
    expect(result.events[0]!.decision).toBe('play-off-required');
  });

  it('does not apply the UEFA exception retroactively to 2025/26', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2025, [1])!;
    expect(result.events[0]!.decision).toBe('play-off-required');
  });

  it.each([2023, 2026])(
    'plans the two survival legs with the better club hosting last in %s',
    (season) => {
      const scores = calendar(winningCycle(17, 18, 19));
      const result = planSerieAPlayOffs(
        table(scores, [[17, 18]]),
        scores,
        season,
        [],
      )!;
      expect(result.events).toEqual([
        {
          kind: 'survival',
          points: -17,
          pointsGroupTeamIds: [17, 18],
          higherSlot: { position: 17, candidateTeamIds: [17] },
          lowerSlot: { position: 18, candidateTeamIds: [18] },
          selection: 'ordered-pair-known',
          decision: 'play-off-required',
          normalFormat: {
            legs: 2,
            firstLegHomeSlot: 'lower',
            secondLegHomeSlot: 'higher',
            neutralVenueAlternative: null,
            extraTime: false,
            awayGoals: false,
            penaltiesOnTie: true,
          },
        },
      ]);
    },
  );

  it('selects only the top two of a larger title points group', () => {
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
      [3, 2, 0, 1],
    ]);
    const result = planSerieAPlayOffs(
      table(scores, [[1, 2, 3]]),
      scores,
      2026,
      [3],
    )!;
    expect(result.events[0]!.pointsGroupTeamIds).toEqual([1, 2, 3]);
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([1]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([2]);
    expect(result.events[0]!.decision).toBe('play-off-required');
  });

  it('selects positions 17/18 from a group spanning positions 16 through 18', () => {
    const scores = calendar([
      [17, 16, 0, 1],
      [18, 16, 0, 1],
      [18, 17, 0, 1],
    ]);
    const result = planSerieAPlayOffs(
      table(scores, [[16, 17, 18]]),
      scores,
      2026,
      [16],
    )!;
    const event = result.events[0]!;
    expect(event.kind).toBe('survival');
    expect(event.pointsGroupTeamIds).toEqual([16, 17, 18]);
    expect(event.higherSlot).toEqual({ position: 17, candidateTeamIds: [17] });
    expect(event.lowerSlot).toEqual({ position: 18, candidateTeamIds: [18] });
    expect(event.decision).toBe('play-off-required');
  });

  it('selects positions 17/18 from a group spanning positions 17 through 19', () => {
    const scores = calendar([
      [18, 17, 0, 1],
      [19, 17, 0, 1],
      [19, 18, 0, 1],
    ]);
    const result = planSerieAPlayOffs(
      table(scores, [[17, 18, 19]]),
      scores,
      2026,
      [],
    )!;
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([17]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([18]);
    expect(result.events[0]!.pointsGroupTeamIds).toEqual([17, 18, 19]);
  });

  it('selects positions 17/18 when four clubs tie at the bottom', () => {
    const scores = calendar([
      [18, 17, 0, 1],
      [19, 17, 0, 1],
      [20, 17, 0, 1],
      [19, 18, 0, 1],
      [20, 18, 0, 1],
      [20, 19, 0, 1],
    ]);
    const result = planSerieAPlayOffs(
      table(scores, [[17, 18, 19, 20]]),
      scores,
      2026,
      [20],
    )!;
    expect(result.events[0]!.higherSlot.candidateTeamIds).toEqual([17]);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([18]);
    expect(result.events[0]!.decision).toBe('play-off-required');
  });

  it('evaluates simultaneous title and survival ties separately', () => {
    const scores = calendar([...winningCycle(1, 2, 3), ...winningCycle(17, 18, 19)]);
    const result = planSerieAPlayOffs(
      table(scores, [
        [1, 2],
        [17, 18],
      ]),
      scores,
      2026,
      [1],
    )!;
    expect(result.events.map(({ kind, decision }) => ({ kind, decision }))).toEqual([
      { kind: 'title', decision: 'classifica-avulsa-applies' },
      { kind: 'survival', decision: 'play-off-required' },
    ]);
  });

  it('does not create play-offs for other points ties', () => {
    const scores = calendar();
    const result = planSerieAPlayOffs(
      table(scores, [
        [2, 3],
        [4, 5],
        [18, 19],
      ]),
      scores,
      2026,
    )!;
    expect(result.events).toEqual([]);
  });

  it('distinguishes an unordered known pair from an unknown participant pair', () => {
    const scores = calendar();
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026, [])!;
    expect(result.events[0]!.selection).toBe('pair-order-needs-draw');
    expect(result.events[0]!.higherSlot).toEqual({
      position: 1,
      candidateTeamIds: [1, 2],
    });
    expect(result.events[0]!.lowerSlot).toEqual({
      position: 2,
      candidateTeamIds: [1, 2],
    });
    expect(result.events[0]!.decision).toBe('play-off-required');
  });

  it('knows the UEFA exception applies to an unordered pair with a finalist', () => {
    const scores = calendar();
    const result = planSerieAPlayOffs(table(scores, [[1, 2]]), scores, 2026, [2])!;
    expect(result.events[0]!.selection).toBe('pair-order-needs-draw');
    expect(result.events[0]!.decision).toBe('classifica-avulsa-applies');
  });

  it.each([
    { finalists: null, decision: 'uefa-finalists-required' },
    { finalists: [], decision: 'play-off-required' },
    { finalists: [1], decision: 'participant-draw-required' },
    { finalists: [1, 2], decision: 'classifica-avulsa-applies' },
  ])('handles a shared three-club draw pool: %j', ({ finalists, decision }) => {
    const scores = calendar();
    const result = planSerieAPlayOffs(
      table(scores, [[1, 2, 3]]),
      scores,
      2026,
      finalists,
    )!;
    const event = result.events[0]!;
    expect(event.selection).toBe('participants-need-draw');
    expect(event.higherSlot.candidateTeamIds).toEqual([1, 2, 3]);
    expect(event.lowerSlot.candidateTeamIds).toEqual([1, 2, 3]);
    expect(event.decision).toBe(decision);
  });

  it.each([
    { finalists: [], decision: 'play-off-required' },
    { finalists: [1], decision: 'classifica-avulsa-applies' },
    { finalists: [2], decision: 'participant-draw-required' },
    { finalists: [2, 3], decision: 'classifica-avulsa-applies' },
  ])(
    'handles a fixed upper club and an unresolved lower slot: %j',
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
      )!;
      const event = result.events[0]!;
      expect(event.higherSlot.candidateTeamIds).toEqual([1]);
      expect(event.lowerSlot.candidateTeamIds).toEqual([2, 3]);
      expect(event.selection).toBe('participants-need-draw');
      expect(event.decision).toBe(decision);
    },
  );

  it.each([
    { finalists: [], decision: 'play-off-required' },
    { finalists: [16], decision: 'participant-draw-required' },
    { finalists: [16, 17], decision: 'classifica-avulsa-applies' },
    { finalists: [18, 19], decision: 'classifica-avulsa-applies' },
    { finalists: [16, 18], decision: 'participant-draw-required' },
  ])(
    'handles distinct draw pools across positions 17/18: %j',
    ({ finalists, decision }) => {
      // Mini-table tiers: [16,17] and [18,19]. Each has equal internal criteria.
      const scores = calendar([
        [18, 16, 0, 1],
        [19, 16, 0, 1],
        [18, 17, 0, 1],
        [19, 17, 0, 1],
      ]);
      const result = planSerieAPlayOffs(
        table(scores, [[16, 17, 18, 19]]),
        scores,
        2026,
        finalists,
      )!;
      const event = result.events[0]!;
      expect(event.higherSlot).toEqual({ position: 17, candidateTeamIds: [16, 17] });
      expect(event.lowerSlot).toEqual({ position: 18, candidateTeamIds: [18, 19] });
      expect(event.selection).toBe('participants-need-draw');
      expect(event.decision).toBe(decision);
    },
  );

  it('exposes the shared draw context when the whole league is tied', () => {
    const scores = calendar();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const result = planSerieAPlayOffs(table(scores, [ids]), scores, 2026, [1])!;
    expect(result.events).toHaveLength(2);
    for (const event of result.events) {
      expect(event.pointsGroupTeamIds).toEqual(ids);
      expect(event.higherSlot.candidateTeamIds).toEqual(ids);
      expect(event.lowerSlot.candidateTeamIds).toEqual(ids);
      expect(event.selection).toBe('participants-need-draw');
      expect(event.decision).toBe('participant-draw-required');
    }
  });

  it('returns a canonical copy of known finalist IDs', () => {
    const scores = calendar();
    const finalists = Object.freeze([18, 1, 3]);
    const result = planSerieAPlayOffs(table(scores), scores, 2026, finalists)!;
    expect(result.uefaFinalistTeamIds).toEqual([1, 3, 18]);
    expect(finalists).toEqual([18, 1, 3]);
  });

  it.each([
    { finalists: [21] },
    { finalists: [1, 1] },
    { finalists: [0] },
    { finalists: [-1] },
    { finalists: [1.5] },
    { finalists: [NaN] },
    { finalists: [Infinity] },
  ])('validates finalist IDs even without a relevant tie: %j', ({ finalists }) => {
    const scores = calendar();
    expect(() => planSerieAPlayOffs(table(scores), scores, 2026, finalists)).toThrow(
      RangeError,
    );
  });

  it('validates supplied finalist data in legacy seasons too', () => {
    const scores = calendar();
    expect(() => planSerieAPlayOffs(table(scores), scores, 2025, [21])).toThrow(
      RangeError,
    );
  });

  it('returns null for unavailable preliminary classifications', () => {
    const scores = calendar();
    expect(planSerieAPlayOffs(table(scores), scores.slice(1), 2026)).toBeNull();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(planSerieAPlayOffs(rows, scores, 2026)).toBeNull();
    expect(planSerieAPlayOffs([], [], 2027)).toBeNull();
  });

  it('delegates invalid seasons and scores to preliminary validation', () => {
    expect(() => planSerieAPlayOffs([], [], 2026.5)).toThrow(RangeError);
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      planSerieAPlayOffs(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() => planSerieAPlayOffs(rows, [scores[0]!, ...scores], 2026)).toThrow(
      RangeError,
    );
  });

  it('preserves frozen inputs and isolates all output arrays', () => {
    const scores = Object.freeze(calendar().map((score) => Object.freeze(score)));
    const rows = Object.freeze(
      table(scores, [[1, 2]]).map((row) => Object.freeze(row)),
    );
    const finalists = Object.freeze([3, 1]);
    const expected = planSerieAPlayOffs(rows, scores, 2026, finalists)!;
    const result = planSerieAPlayOffs(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
      [...finalists].reverse(),
    )!;
    expect(result).toEqual(expected);
    result.events[0]!.higherSlot.candidateTeamIds.push(999);
    expect(result.events[0]!.lowerSlot.candidateTeamIds).toEqual([1, 2]);
    expect(result.events[0]!.pointsGroupTeamIds).toEqual([1, 2]);
    expect(result.preliminary.groups[0]!.teamIds).toEqual([1, 2]);
    result.uefaFinalistTeamIds!.push(999);
    expect(planSerieAPlayOffs(rows, scores, 2026, finalists)).toEqual(expected);
  });
});
