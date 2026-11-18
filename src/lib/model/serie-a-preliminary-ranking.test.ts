import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import type { RoundRobinMatchScore } from './round-robin-season';
import {
  rankSerieAPreliminaryTable,
  SERIE_A_PRELIMINARY_RANKING_ALGORITHM,
} from './serie-a-preliminary-ranking';
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
  // Synthetic official deductions isolate point ties without changing score totals.
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

describe('Serie A preliminary classification', () => {
  it.each([2023, 2024, 2025, 2026])(
    'ranks the configured complete season %s before play-offs',
    (season) => {
      const scores = calendar();
      const result = rankSerieAPreliminaryTable(table(scores), scores, season)!;
      expect(scores).toHaveLength(380);
      expect(result.algorithm).toBe(SERIE_A_PRELIMINARY_RANKING_ALGORITHM);
      expect(result.scope).toBe('before-play-offs');
      expect(result.season).toBe(season);
      expect(result.qualificationNote).toBe(
        getCompetitionSeasonConfig('SA', season)!.qualificationNote,
      );
      expect(result.groups).toEqual(
        Array.from({ length: 20 }, (_, index) => ({
          from: index + 1,
          to: index + 1,
          teamIds: [index + 1],
          points: -(index + 1),
          reason: 'points',
        })),
      );
    },
  );

  it('uses official adjusted points before head-to-head results', () => {
    const scores = calendar([[2, 1, 0, 1]]);
    const rows = table(scores, [1, 2]);
    rows[1]!.points = 1;
    expect(rankSerieAPreliminaryTable(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [2],
      points: 1,
      reason: 'points',
    });
  });

  it('compares head-to-head points before head-to-head goal difference', () => {
    // Mini-table points: club 1 = 9, club 3 = 6, club 2 = 3.
    // Club 3 has a much better direct goal difference than club 1.
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 10, 0],
    ]);
    const result = rankSerieAPreliminaryTable(
      table(scores, [1, 2, 3]),
      scores,
      2026,
    )!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], points: 0, reason: 'classifica-avulsa' },
      { from: 2, to: 2, teamIds: [3], points: 0, reason: 'classifica-avulsa' },
      { from: 3, to: 3, teamIds: [2], points: 0, reason: 'classifica-avulsa' },
    ]);
  });

  it('uses direct goal difference after equal direct points', () => {
    const scores = calendar([
      [1, 2, 4, 0],
      [3, 2, 0, 9],
    ]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      points: 0,
      reason: 'classifica-avulsa',
    });
  });

  it('uses overall goal difference before overall goals scored', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 4, 3, 2],
    ]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      points: 0,
      reason: 'classifica-avulsa',
    });
  });

  it('uses overall goals scored after equal overall goal difference', () => {
    const scores = calendar([[1, 3, 2, 1]]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      points: 0,
      reason: 'classifica-avulsa',
    });
  });

  it('does not insert a head-to-head away-goals criterion', () => {
    const scores = calendar([
      [1, 2, 2, 1],
      [1, 3, 2, 0],
    ]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      points: 0,
      reason: 'classifica-avulsa',
    });
  });

  it('does not use all away goals to resolve complete equality', () => {
    const scores = calendar([
      [1, 3, 2, 1],
      [4, 2, 2, 1],
    ]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 2,
      teamIds: [1, 2],
      points: 0,
      reason: 'drawing-of-lots-required',
    });
  });

  it('does not introduce a wins criterion after equal goals', () => {
    const scores = calendar([
      [1, 3, 3, 3],
      [4, 1, 0, 0],
      [2, 5, 3, 2],
    ]);
    expect(
      rankSerieAPreliminaryTable(table(scores, [1, 2]), scores, 2026)!.groups[0],
    ).toEqual({
      from: 1,
      to: 2,
      teamIds: [1, 2],
      points: 0,
      reason: 'drawing-of-lots-required',
    });
  });

  it('builds the mini-table from all point-tied clubs before comparing overall GD', () => {
    const scores = calendar([
      [3, 1, 0, 1],
      [3, 2, 2, 0],
    ]);
    const result = rankSerieAPreliminaryTable(
      table(scores, [1, 2, 3]),
      scores,
      2026,
    )!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], points: 0, reason: 'classifica-avulsa' },
      { from: 2, to: 2, teamIds: [2], points: 0, reason: 'classifica-avulsa' },
      { from: 3, to: 3, teamIds: [3], points: 0, reason: 'classifica-avulsa' },
    ]);
  });

  it('keeps the original mini-table after a partial head-to-head points split', () => {
    // All overall GD are zero. Direct points: 9, 0, 9; direct GD: +10, -13, +3.
    // Recalculating a two-club mini-table for 1/3 would reverse their order.
    const scores = calendar([
      [2, 1, 0, 1],
      [1, 2, 10, 0],
      [3, 1, 2, 0],
      [2, 3, 0, 1],
      [4, 1, 11, 0],
      [4, 3, 4, 0],
      [2, 4, 14, 0],
    ]);
    const result = rankSerieAPreliminaryTable(
      table(scores, [1, 2, 3]),
      scores,
      2026,
    )!;
    expect(result.groups.slice(0, 3).map(({ teamIds }) => teamIds)).toEqual([
      [1],
      [3],
      [2],
    ]);
  });

  it('does not restart direct comparison after an overall goal-difference split', () => {
    const scores = calendar([...winningCycle(1, 2, 3), [1, 4, 2, 0], [3, 5, 2, 1]]);
    const result = rankSerieAPreliminaryTable(
      table(scores, [1, 2, 3]),
      scores,
      2026,
    )!;
    expect(result.groups.slice(0, 3).map(({ teamIds }) => teamIds)).toEqual([
      [1],
      [3],
      [2],
    ]);
  });

  it('keeps completely equal clubs in a canonical range requiring a draw', () => {
    const scores = calendar();
    const result = rankSerieAPreliminaryTable(
      table(scores, [1, 2, 3]),
      scores,
      2026,
    )!;
    expect(result.groups[0]).toEqual({
      from: 1,
      to: 3,
      teamIds: [1, 2, 3],
      points: 0,
      reason: 'drawing-of-lots-required',
    });
  });

  it('supports an entire points-tied league without inventing an order', () => {
    const scores = calendar();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(
      rankSerieAPreliminaryTable(table(scores, ids), scores, 2026)!.groups,
    ).toEqual([
      {
        from: 1,
        to: 20,
        teamIds: ids,
        points: 0,
        reason: 'drawing-of-lots-required',
      },
    ]);
  });

  it('retains the correct position offset and negative points in a mid-table tie', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[8]!.points = rows[7]!.points;
    expect(
      rankSerieAPreliminaryTable(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 8,
      ),
    ).toEqual({
      from: 8,
      to: 9,
      teamIds: [8, 9],
      points: -8,
      reason: 'drawing-of-lots-required',
    });
  });

  it('labels resolved title and survival mini-table positions as before play-offs', () => {
    const scores = calendar([...winningCycle(1, 2, 3), ...winningCycle(17, 18, 19)]);
    const rows = table(scores);
    rows[1]!.points = rows[0]!.points;
    rows[17]!.points = rows[16]!.points;
    const result = rankSerieAPreliminaryTable(rows, scores, 2026)!;
    expect(result.scope).toBe('before-play-offs');
    expect(
      result.groups.filter(({ from }) => [1, 2, 17, 18].includes(from)),
    ).toEqual([
      { from: 1, to: 1, teamIds: [1], points: -1, reason: 'classifica-avulsa' },
      { from: 2, to: 2, teamIds: [2], points: -1, reason: 'classifica-avulsa' },
      { from: 17, to: 17, teamIds: [17], points: -17, reason: 'classifica-avulsa' },
      { from: 18, to: 18, teamIds: [18], points: -17, reason: 'classifica-avulsa' },
    ]);
  });

  it('returns null for incomplete calendars and partial rosters', () => {
    const scores = calendar();
    expect(
      rankSerieAPreliminaryTable(table(scores), scores.slice(1), 2026),
    ).toBeNull();
    const partial = scores.filter(
      ({ homeTeamId, awayTeamId }) => homeTeamId < 20 && awayTeamId < 20,
    );
    expect(
      rankSerieAPreliminaryTable(table(partial).slice(0, 19), partial, 2026),
    ).toBeNull();
  });

  it('returns null for mismatched final score totals', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(rankSerieAPreliminaryTable(rows, scores, 2026)).toBeNull();
  });

  it('rejects duplicate oriented pairs even with reconciled team totals', () => {
    const scores = calendar();
    const index = scores.findIndex(
      ({ homeTeamId, awayTeamId }) => homeTeamId === 2 && awayTeamId === 1,
    );
    scores[index] = { ...scores[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(rankSerieAPreliminaryTable(table(scores), scores, 2026)).toBeNull();
  });

  it('handles an unconfigured season and invalid year values', () => {
    expect(rankSerieAPreliminaryTable([], [], 2027)).toBeNull();
    expect(() => rankSerieAPreliminaryTable([], [], 2026.5)).toThrow(RangeError);
    expect(() => rankSerieAPreliminaryTable([], [], Infinity)).toThrow(RangeError);
  });

  it('validates scores and safe arithmetic through the main call', () => {
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      rankSerieAPreliminaryTable(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() =>
      rankSerieAPreliminaryTable(rows, [scores[0]!, ...scores], 2026),
    ).toThrow(RangeError);
    expect(() =>
      rankSerieAPreliminaryTable(
        rows,
        [{ ...scores[0]!, awayTeamId: 21 }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() =>
      rankSerieAPreliminaryTable(
        rows,
        [
          { ...scores[0]!, homeGoals90: Number.MAX_SAFE_INTEGER },
          ...scores.slice(1),
        ],
        2026,
      ),
    ).toThrow(RangeError);
  });

  it('preserves frozen inputs and returns fresh canonical results', () => {
    const scores = Object.freeze(
      calendar(winningCycle(1, 2, 3)).map((score) => Object.freeze(score)),
    );
    const rows = Object.freeze(
      table(scores, [1, 2, 3]).map((row) => Object.freeze(row)),
    );
    const expected = rankSerieAPreliminaryTable(rows, scores, 2026)!;
    const result = rankSerieAPreliminaryTable(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
    )!;
    expect(result).toEqual(expected);
    result.groups[0]!.teamIds.push(999);
    expect(rankSerieAPreliminaryTable(rows, scores, 2026)).toEqual(expected);
  });
});
