import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  LIGUE1_RANKING_ALGORITHM,
  rankLigue1Season,
  type Ligue1DisciplinaryPoints,
} from './ligue1-ranking';
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
  for (let homeTeamId = 1; homeTeamId <= 18; homeTeamId += 1) {
    for (let awayTeamId = 1; awayTeamId <= 18; awayTeamId += 1) {
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
    Array.from({ length: 18 }, (_, index) => ({
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
  // Synthetic official deductions isolate ties without changing score statistics.
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

describe('Ligue 1 final-season ranking', () => {
  it.each([2023, 2024, 2025, 2026])(
    'ranks complete season %s and reports its explicit ruleset',
    (season) => {
      const scores = calendar();
      const result = rankLigue1Season(table(scores), scores, season)!;
      expect(scores).toHaveLength(306);
      expect(result.algorithm).toBe(LIGUE1_RANKING_ALGORITHM);
      expect(result.season).toBe(season);
      expect(result.ruleset).toBe(
        season < 2025 ? 'lfp-518-ter-2023-2025' : 'lfp-518-ter-2025-2027',
      );
      expect(result.qualificationNote).toBe(
        getCompetitionSeasonConfig('FL1', season)!.qualificationNote,
      );
      expect(result.groups).toEqual(
        Array.from({ length: 18 }, (_, index) => ({
          from: index + 1,
          to: index + 1,
          teamIds: [index + 1],
          reason: 'table-criteria',
        })),
      );
    },
  );

  it('puts official points before overall goal difference', () => {
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 6, 0],
    ]);
    const rows = table(scores, [1, 2]);
    rows[0]!.points = 1;
    expect(rankLigue1Season(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      reason: 'table-criteria',
    });
  });

  it.each([2023, 2026])(
    'puts overall goal difference before direct results in %s',
    (season) => {
      // Club 1 won both direct matches but has worse overall goal difference.
      const scores = calendar([
        [2, 1, 0, 1],
        [3, 1, 6, 0],
      ]);
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, season)!.groups[0],
      ).toEqual({
        from: 1,
        to: 1,
        teamIds: [2],
        reason: 'table-criteria',
      });
    },
  );

  it.each([2023, 2026])(
    'uses direct points before overall goals scored in %s',
    (season) => {
      const scores = calendar([...winningCycle(1, 2, 3), [2, 4, 2, 1]]);
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, season)!.groups[0],
      ).toEqual({
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'head-to-head',
      });
    },
  );

  it.each([2023, 2026])(
    'uses direct goal difference after equal direct points in %s',
    (season) => {
      const scores = calendar([
        [1, 2, 3, 0],
        [3, 1, 3, 0],
        [2, 3, 3, 0],
        [2, 4, 2, 1],
      ]);
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, season)!.groups[0],
      ).toEqual({
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'head-to-head',
      });
    },
  );

  it.each([2023, 2024])(
    'uses head-to-head goals before all goals in legacy season %s',
    (season) => {
      // Mini-table points/GD are equal. Clubs 1/2 have 3 direct goals and club 3
      // has 2, although club 3 scored more across the whole season.
      const scores = calendar([
        [1, 2, 2, 1],
        [3, 4, 4, 3],
      ]);
      const result = rankLigue1Season(table(scores, [1, 2, 3]), scores, season)!;
      expect(result.groups.slice(0, 3)).toEqual([
        { from: 1, to: 1, teamIds: [2], reason: 'head-to-head' },
        { from: 2, to: 2, teamIds: [1], reason: 'head-to-head' },
        { from: 3, to: 3, teamIds: [3], reason: 'head-to-head' },
      ]);
    },
  );

  it.each([2025, 2026])(
    'skips legacy head-to-head goals in modern season %s',
    (season) => {
      const scores = calendar([
        [1, 2, 2, 1],
        [3, 4, 4, 3],
      ]);
      const result = rankLigue1Season(table(scores, [1, 2, 3]), scores, season)!;
      expect(result.groups.slice(0, 2)).toEqual([
        { from: 1, to: 1, teamIds: [3], reason: 'season-criteria' },
        { from: 2, to: 3, teamIds: [1, 2], reason: 'disciplinary-data-required' },
      ]);
    },
  );

  it.each([2023, 2024])(
    'uses direct away goals before all goals in legacy season %s',
    (season) => {
      const scores = calendar([
        [1, 2, 2, 1],
        [3, 1, 2, 1],
      ]);
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, season)!.groups[0],
      ).toEqual({
        from: 1,
        to: 1,
        teamIds: [2],
        reason: 'head-to-head',
      });
    },
  );

  it.each([2025, 2026])(
    'skips legacy direct away goals in modern season %s',
    (season) => {
      const scores = calendar([
        [1, 2, 2, 1],
        [3, 1, 2, 1],
      ]);
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, season)!.groups[0],
      ).toEqual({
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'season-criteria',
      });
    },
  );

  it('puts all goals before all away goals under the legacy rules', () => {
    const scores = calendar([
      [1, 3, 3, 2],
      [4, 2, 2, 1],
    ]);
    expect(rankLigue1Season(table(scores, [1, 2]), scores, 2024)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'season-criteria',
      },
    );
  });

  it('uses all away goals after equal overall goals under the legacy rules', () => {
    const scores = calendar([
      [1, 3, 2, 1],
      [4, 2, 2, 1],
    ]);
    expect(rankLigue1Season(table(scores, [1, 2]), scores, 2024)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [2],
        reason: 'season-criteria',
      },
    );
  });

  it('does not use all away goals under the modern rules', () => {
    const scores = calendar([
      [1, 3, 2, 1],
      [4, 2, 2, 1],
    ]);
    expect(rankLigue1Season(table(scores, [1, 2]), scores, 2026)!.groups[0]).toEqual(
      {
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'disciplinary-data-required',
      },
    );
  });

  it.each([2025, 2026])(
    'uses wins after equal goals and before discipline in %s',
    (season) => {
      // Equal GF/GA: 19/19. Club 1 has 16 wins and 2 draws; club 2 has 17 wins.
      const scores = calendar([
        [1, 3, 3, 3],
        [4, 1, 0, 0],
        [2, 5, 3, 2],
      ]);
      const result = rankLigue1Season(table(scores, [1, 2]), scores, season, [
        { teamId: 1, points: 0 },
        { teamId: 2, points: 100 },
      ])!;
      expect(result.groups[0]).toEqual({
        from: 1,
        to: 1,
        teamIds: [2],
        reason: 'season-criteria',
      });
    },
  );

  it('does not introduce a wins criterion into the legacy rules', () => {
    const scores = calendar([
      [1, 3, 3, 3],
      [4, 1, 0, 0],
      [2, 5, 3, 2],
    ]);
    expect(rankLigue1Season(table(scores, [1, 2]), scores, 2024)!.groups[0]).toEqual(
      {
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'disciplinary-data-required',
      },
    );
  });

  it.each([2025, 2026])(
    'uses away wins instead of legacy away goals in %s',
    (season) => {
      // Equal overall GF/GA (19/19) and 17 wins. Club 1 has an away win and
      // one away goal; club 2 has two away goals but no away wins.
      const scores = calendar([
        [1, 3, 0, 1],
        [4, 1, 0, 1],
        [5, 2, 3, 2],
        [1, 6, 3, 2],
      ]);
      const result = rankLigue1Season(table(scores, [1, 2]), scores, season, [
        { teamId: 1, points: 100 },
        { teamId: 2, points: 0 },
      ])!;
      expect(result.groups[0]).toEqual({
        from: 1,
        to: 1,
        teamIds: [1],
        reason: 'season-criteria',
      });
    },
  );

  it('keeps the legacy away-goals outcome for the same scores', () => {
    const scores = calendar([
      [1, 3, 0, 1],
      [4, 1, 0, 1],
      [5, 2, 3, 2],
      [1, 6, 3, 2],
    ]);
    expect(rankLigue1Season(table(scores, [1, 2]), scores, 2024)!.groups[0]).toEqual(
      {
        from: 1,
        to: 1,
        teamIds: [2],
        reason: 'season-criteria',
      },
    );
  });

  it.each([2023, 2024, 2025, 2026])(
    'prefers fewer final disciplinary points in %s',
    (season) => {
      const scores = calendar();
      const result = rankLigue1Season(table(scores, [1, 2]), scores, season, [
        { teamId: 1, points: 3 },
        { teamId: 2, points: 0 },
      ])!;
      expect(result.groups.slice(0, 2)).toEqual([
        { from: 1, to: 1, teamIds: [2], reason: 'season-criteria' },
        { from: 2, to: 2, teamIds: [1], reason: 'season-criteria' },
      ]);
    },
  );

  it.each(
    (
      [
        [],
        [{ teamId: 1, points: 0 }],
        [
          { teamId: 1, points: 0 },
          { teamId: 2, points: null },
        ],
      ] satisfies Ligue1DisciplinaryPoints[][]
    ).map((discipline) => ({ discipline })),
  )(
    'preserves the full range when disciplinary data is incomplete: %j',
    ({ discipline }) => {
      const scores = calendar();
      expect(
        rankLigue1Season(table(scores, [1, 2]), scores, 2026, discipline)!.groups[0],
      ).toEqual({
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'disciplinary-data-required',
      });
    },
  );

  it.each([2025, 2026])(
    'requires a draw of lots after complete modern equality in %s',
    (season) => {
      const scores = calendar();
      const result = rankLigue1Season(
        table(scores, [1, 2, 3]),
        scores,
        season,
        [1, 2, 3].map((teamId) => ({ teamId, points: 0 })),
      )!;
      expect(result.groups[0]).toEqual({
        from: 1,
        to: 3,
        teamIds: [1, 2, 3],
        reason: 'drawing-of-lots-required',
      });
    },
  );

  it.each([2023, 2024])(
    'leaves complete legacy equality for an LFP decision in %s',
    (season) => {
      const scores = calendar();
      const result = rankLigue1Season(table(scores, [1, 2]), scores, season, [
        { teamId: 1, points: 0 },
        { teamId: 2, points: 0 },
      ])!;
      expect(result.groups[0]).toEqual({
        from: 1,
        to: 2,
        teamIds: [1, 2],
        reason: 'league-decision-required',
      });
    },
  );

  it('forms the head-to-head group after the overall goal-difference comparison', () => {
    const scores = calendar([
      [3, 1, 0, 1],
      [3, 2, 2, 0],
    ]);
    const result = rankLigue1Season(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'table-criteria' },
      { from: 2, to: 2, teamIds: [3], reason: 'head-to-head' },
      { from: 3, to: 3, teamIds: [2], reason: 'head-to-head' },
    ]);
  });

  it('keeps all direct criteria within the original points/GD-tied group', () => {
    // All overall GD are zero. Direct points: 9, 0, 9; direct GD: +10, -13, +3.
    // Restarting for clubs 1/3 would reverse the mini-table outcome.
    const scores = calendar([
      [2, 1, 0, 1],
      [1, 2, 10, 0],
      [3, 1, 2, 0],
      [2, 3, 0, 1],
      [4, 1, 11, 0],
      [4, 3, 4, 0],
      [2, 4, 14, 0],
    ]);
    const result = rankLigue1Season(table(scores, [1, 2, 3]), scores, 2026)!;
    expect(result.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head' },
      { from: 2, to: 2, teamIds: [3], reason: 'head-to-head' },
      { from: 3, to: 3, teamIds: [2], reason: 'head-to-head' },
    ]);
  });

  it('keeps the right mid-table offset and unresolved range', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[8]!.points = rows[7]!.points;
    expect(
      rankLigue1Season(rows, scores, 2026)!.groups.find(({ from }) => from === 8),
    ).toEqual({
      from: 8,
      to: 9,
      teamIds: [8, 9],
      reason: 'disciplinary-data-required',
    });
  });

  it('returns null for incomplete calendars and mismatched season totals', () => {
    const scores = calendar();
    expect(rankLigue1Season(table(scores), scores.slice(1), 2026)).toBeNull();
    const partial = scores.filter(
      ({ homeTeamId, awayTeamId }) => homeTeamId < 18 && awayTeamId < 18,
    );
    expect(rankLigue1Season(table(partial).slice(0, 17), partial, 2026)).toBeNull();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(rankLigue1Season(rows, scores, 2026)).toBeNull();
  });

  it('rejects duplicate oriented pairs despite reconciled statistics', () => {
    const scores = calendar();
    const index = scores.findIndex(
      ({ homeTeamId, awayTeamId }) => homeTeamId === 2 && awayTeamId === 1,
    );
    scores[index] = { ...scores[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(rankLigue1Season(table(scores), scores, 2026)).toBeNull();
  });

  it('handles unconfigured seasons and delegates invalid score validation', () => {
    expect(rankLigue1Season([], [], 2027)).toBeNull();
    expect(() => rankLigue1Season([], [], 2026.5)).toThrow(RangeError);
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      rankLigue1Season(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() => rankLigue1Season(rows, [scores[0]!, ...scores], 2026)).toThrow(
      RangeError,
    );
  });

  it.each(
    (
      [
        [{ teamId: 19, points: 0 }],
        [
          { teamId: 1, points: 0 },
          { teamId: 1, points: 1 },
        ],
        [{ teamId: 1, points: -1 }],
        [{ teamId: 1, points: 0.5 }],
        [{ teamId: 1, points: Infinity }],
        [{ teamId: 1, points: Number.MAX_SAFE_INTEGER + 1 }],
      ] satisfies Ligue1DisciplinaryPoints[][]
    ).map((discipline) => ({ discipline })),
  )('validates discipline even when the table has no tie: %j', ({ discipline }) => {
    const scores = calendar();
    expect(() => rankLigue1Season(table(scores), scores, 2026, discipline)).toThrow(
      RangeError,
    );
  });

  it('preserves frozen inputs and returns independent canonical results', () => {
    const scores = Object.freeze(
      calendar(winningCycle(1, 2, 3)).map((score) => Object.freeze(score)),
    );
    const rows = Object.freeze(
      table(scores, [1, 2, 3]).map((row) => Object.freeze(row)),
    );
    const discipline = Object.freeze(
      [1, 2, 3].map((teamId) => Object.freeze({ teamId, points: null })),
    );
    const expected = rankLigue1Season(rows, scores, 2026, discipline)!;
    const result = rankLigue1Season(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
      [...discipline].reverse(),
    )!;
    expect(result).toEqual(expected);
    result.groups[0]!.teamIds.push(999);
    expect(rankLigue1Season(rows, scores, 2026, discipline)).toEqual(expected);
  });
});
