import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  LA_LIGA_RANKING_ALGORITHM,
  rankLaLigaSeason,
  type LaLigaFairPlayRank,
} from './la-liga-ranking';
import type { RoundRobinMatchScore } from './round-robin-season';
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
  tiedIds: readonly number[] = [],
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
  // Synthetic official deductions isolate ties without changing the score totals.
  const tied = new Set(tiedIds);
  return rows.map((row) => ({
    ...row,
    points: tied.has(row.teamId) ? 0 : -row.teamId,
  }));
}

function winningCycle(a: number, b: number, c: number): Override[] {
  return [
    [b, a, 0, 1],
    [a, c, 0, 1],
    [c, b, 0, 1],
  ];
}

describe('La Liga final-season ranking', () => {
  it.each([2023, 2024, 2025, 2026])(
    'ranks configured season %s and retains its qualification note',
    (season) => {
      const scores = calendar();
      const result = rankLaLigaSeason(table(scores), scores, season)!;
      expect(scores).toHaveLength(380);
      expect(result.algorithm).toBe(LA_LIGA_RANKING_ALGORITHM);
      expect(result.season).toBe(season);
      expect(result.qualificationNote).toBe(
        getCompetitionSeasonConfig('PD', season)!.qualificationNote,
      );
      expect(result.groups).toEqual(
        Array.from({ length: 20 }, (_, index) => ({
          from: index + 1,
          to: index + 1,
          teamIds: [index + 1],
          reason: 'points',
        })),
      );
    },
  );

  it('ranks points before head-to-head results', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [1, 2]);
    rows[1]!.points = 1;
    expect(rankLaLigaSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [2],
      reason: 'points',
    });
  });

  it('puts direct goal difference before overall statistics and Fair Play', () => {
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 2, 0, 9],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2]), scores, 2026, [
      { teamId: 1, rank: 2 },
      { teamId: 2, rank: 1 },
    ])!;
    expect(result.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head-goal-difference' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('uses aggregate goals when the pair won one match each', () => {
    const scores = calendar([
      [1, 2, 4, 0],
      [3, 2, 0, 9],
    ]);
    expect(rankLaLigaSeason(table(scores, [1, 2]), scores, 2026)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'head-to-head-goal-difference',
      },
    );
  });

  it('uses overall goal difference before goals scored', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 4, 3, 2],
    ]);
    expect(rankLaLigaSeason(table(scores, [1, 2]), scores, 2026)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'overall-goal-difference',
      },
    );
  });

  it('does not insert an away-goals rule after equal aggregate goals', () => {
    // Club 2 scored the only head-to-head away goal. Club 1 has better overall GD.
    const scores = calendar([
      [1, 2, 2, 1],
      [1, 3, 2, 0],
    ]);
    expect(rankLaLigaSeason(table(scores, [1, 2]), scores, 2026)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'overall-goal-difference',
      },
    );
  });

  it('uses overall goals scored before Fair Play', () => {
    const scores = calendar([[1, 3, 2, 1]]);
    const result = rankLaLigaSeason(table(scores, [1, 2]), scores, 2026, [
      { teamId: 1, rank: 2 },
      { teamId: 2, rank: 1 },
    ])!;
    expect(result.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      reason: 'overall-goals-scored',
    });
  });

  it('uses supplied final Fair Play ranks with a smaller number ranked first', () => {
    const scores = calendar();
    const result = rankLaLigaSeason(table(scores, [1, 2]), scores, 2026, [
      { teamId: 1, rank: 20 },
      { teamId: 2, rank: 1 },
    ])!;
    expect(result.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [2], reason: 'fair-play' },
      { from: 2, to: 2, teamIds: [1], reason: 'fair-play' },
    ]);
  });

  it.each(
    (
      [
        [],
        [{ teamId: 1, rank: 1 }],
        [
          { teamId: 1, rank: 1 },
          { teamId: 2, rank: null },
        ],
      ] satisfies LaLigaFairPlayRank[][]
    ).map((fairPlay) => ({ fairPlay })),
  )(
    'retains the full pair range when a Fair Play rank is unavailable: %j',
    ({ fairPlay }) => {
      const scores = calendar();
      expect(
        rankLaLigaSeason(table(scores, [1, 2]), scores, 2026, fairPlay)!.groups[0],
      ).toEqual({
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'fair-play-data-required',
      });
    },
  );

  it('requires a neutral play-off after complete equality of a pair', () => {
    const scores = calendar();
    const result = rankLaLigaSeason(table(scores, [1, 2]), scores, 2026, [
      { teamId: 1, rank: 1 },
      { teamId: 2, rank: 1 },
    ])!;
    expect(result.groups[0]).toEqual({
      from: 1,
      to: 2,
      teamIds: [1, 2],
      reason: 'play-off-required',
    });
  });

  it('preserves a completely tied larger group for a Federation decision', () => {
    const scores = calendar();
    const result = rankLaLigaSeason(
      table(scores, [1, 2, 3]),
      scores,
      2026,
      [1, 2, 3].map((teamId) => ({ teamId, rank: 1 })),
    )!;
    expect(result.groups[0]).toEqual({
      from: 1,
      to: 3,
      teamIds: [1, 2, 3],
      reason: 'federation-decision-required',
    });
  });

  it('compares mini-table points before direct or overall goal differences', () => {
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
      [3, 2, 0, 1],
      [3, 4, 50, 0],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head-points' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-points' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head-points' },
    ]);
  });

  it('uses mini-table goal difference after equal mini-table points', () => {
    const scores = calendar([
      [1, 2, 4, 0],
      [3, 1, 2, 0],
      [2, 4, 8, 0],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head-goal-difference' },
      { from: 2, to: 2, teamIds: [3], reason: 'head-to-head-goal-difference' },
      { from: 3, to: 3, teamIds: [2], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('restarts the two-club rules after a mini-table points split', () => {
    // Club 1 has 12 points; 2 and 3 have 3 each. The original mini-table GD
    // favors club 3, but the two-club aggregate favors club 2.
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
      [1, 2, 10, 0],
      [2, 3, 2, 0],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head-points' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-goal-difference' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('recomputes mini-table points within a remaining three-club subgroup', () => {
    // Four-club points: 9, 8, 8, 8. After removing club 1, points: 8, 5, 2.
    const scores = calendar([
      [2, 1, 0, 1],
      [1, 4, 0, 1],
      [3, 2, 0, 0],
      [4, 2, 0, 0],
      [4, 3, 0, 0],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3, 4]), scores, 2026)!;
    expect(result.groups.slice(0, 4)).toEqual(
      [1, 2, 3, 4].map((teamId, index) => ({
        from: index + 1,
        to: index + 1,
        teamIds: [teamId],
        reason: 'head-to-head-points',
      })),
    );
  });

  it('restarts after a mini-table goal-difference split', () => {
    // Initial mini-table GD: +1, -2, +1. The remaining pair is won by club 3,
    // while overall goals scored would favor club 1.
    const scores = calendar([
      [1, 2, 3, 0],
      [3, 1, 2, 0],
    ]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3).map(({ teamIds }) => teamIds)).toEqual([
      [3],
      [1],
      [2],
    ]);
  });

  it('restarts direct comparison after an overall goal-difference split', () => {
    // A three-way cycle has equal mini-table points and GD. Club 1 is then
    // separated by overall GD. Direct comparison puts 2 before the higher-scoring 3.
    const scores = calendar([...winningCycle(1, 2, 3), [1, 4, 2, 0], [3, 5, 2, 1]]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'overall-goal-difference' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-goal-difference' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('restarts after an overall goals-scored split', () => {
    const scores = calendar([...winningCycle(1, 2, 3), [1, 4, 3, 2]]);
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'overall-goals-scored' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-goal-difference' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('restarts after a partial Fair Play split', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const result = rankLaLigaSeason(table(scores, [1, 2, 3]), scores, 2026, [
      { teamId: 1, rank: 1 },
      { teamId: 2, rank: 2 },
      { teamId: 3, rank: 2 },
    ])!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'fair-play' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head-goal-difference' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head-goal-difference' },
    ]);
  });

  it('keeps the right position offset and unresolved range in mid-table', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[8]!.points = rows[7]!.points;
    expect(
      rankLaLigaSeason(rows, scores, 2026)!.groups.find(({ from }) => from === 8),
    ).toEqual({
      from: 8,
      to: 9,
      teamIds: [8, 9],
      reason: 'fair-play-data-required',
    });
  });

  it('returns null for incomplete calendars or mismatched final totals', () => {
    const scores = calendar();
    expect(rankLaLigaSeason(table(scores), scores.slice(1), 2026)).toBeNull();
    const partial = scores.filter(
      ({ homeTeamId, awayTeamId }) => homeTeamId < 20 && awayTeamId < 20,
    );
    expect(rankLaLigaSeason(table(partial).slice(0, 19), partial, 2026)).toBeNull();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(rankLaLigaSeason(rows, scores, 2026)).toBeNull();
  });

  it('rejects duplicate oriented pairs even with reconciled final totals', () => {
    const scores = calendar();
    const index = scores.findIndex(
      ({ homeTeamId, awayTeamId }) => homeTeamId === 2 && awayTeamId === 1,
    );
    scores[index] = { ...scores[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(rankLaLigaSeason(table(scores), scores, 2026)).toBeNull();
  });

  it('returns null for unconfigured seasons and delegates invalid score validation', () => {
    expect(rankLaLigaSeason([], [], 2027)).toBeNull();
    expect(() => rankLaLigaSeason([], [], 2026.5)).toThrow(RangeError);
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      rankLaLigaSeason(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() => rankLaLigaSeason(rows, [scores[0]!, ...scores], 2026)).toThrow(
      RangeError,
    );
  });

  it.each(
    (
      [
        [{ teamId: 21, rank: 1 }],
        [
          { teamId: 1, rank: 1 },
          { teamId: 1, rank: 2 },
        ],
        [{ teamId: 1, rank: 0 }],
        [{ teamId: 1, rank: -1 }],
        [{ teamId: 1, rank: 1.5 }],
        [{ teamId: 1, rank: Infinity }],
        [{ teamId: 1, rank: Number.MAX_SAFE_INTEGER + 1 }],
      ] satisfies LaLigaFairPlayRank[][]
    ).map((fairPlay) => ({ fairPlay })),
  )(
    'validates supplemental Fair Play data even without a tie: %j',
    ({ fairPlay }) => {
      const scores = calendar();
      expect(() => rankLaLigaSeason(table(scores), scores, 2026, fairPlay)).toThrow(
        RangeError,
      );
    },
  );

  it('preserves frozen inputs and returns independent canonical results', () => {
    const scores = Object.freeze(
      calendar(winningCycle(1, 2, 3)).map((score) => Object.freeze(score)),
    );
    const rows = Object.freeze(
      table(scores, [1, 2, 3]).map((row) => Object.freeze(row)),
    );
    const fairPlay = Object.freeze(
      [1, 2, 3].map((teamId) => Object.freeze({ teamId, rank: null })),
    );
    const expected = rankLaLigaSeason(rows, scores, 2026, fairPlay)!;
    const result = rankLaLigaSeason(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
      [...fairPlay].reverse(),
    )!;
    expect(result).toEqual(expected);
    result.groups[0]!.teamIds.push(999);
    expect(rankLaLigaSeason(rows, scores, 2026, fairPlay)).toEqual(expected);
  });
});
