import { describe, expect, it } from 'vitest';

import {
  CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM,
  rankChampionsLeaguePhase,
  type ChampionsLeaguePhaseTieBreakContext,
} from './champions-league-phase-ranking';
import { projectSeasonStats } from './season-stats';

const ids = Array.from({ length: 36 }, (_, index) => index + 1);

function calendar(seed?: number) {
  let state = seed ?? 0;
  function goals() {
    if (seed === undefined) return 0;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 24) % 4;
  }

  return ids.flatMap((homeTeamId) =>
    [1, 2, 3, 4].map((offset) => ({
      id: (homeTeamId - 1) * 4 + offset,
      homeTeamId,
      awayTeamId: ((homeTeamId - 1 + offset) % ids.length) + 1,
      homeGoals90: goals(),
      awayGoals90: goals(),
    })),
  );
}

type Score = ReturnType<typeof calendar>[number];

function table(scores: Score[]) {
  const empty = ids.map((teamId) => ({
    teamId,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  return projectSeasonStats(
    empty,
    scores.map((score) => ({ ...score, source: 'simulated' })),
  )!;
}

function context(
  overrides: Record<number, Partial<ChampionsLeaguePhaseTieBreakContext>> = {},
) {
  return ids.map((teamId) => ({
    teamId,
    disciplinaryPoints: 3,
    clubCoefficient: 9.125,
    ...overrides[teamId],
  }));
}

describe('final UEFA Champions League league phase ranking', () => {
  it.each([2024, 2025, 2026])(
    'supports the complete league phase starting in %s',
    (season) => {
      const scores = calendar(1);
      const rows = table(scores);
      const result = rankChampionsLeaguePhase(rows, scores, season)!;
      expect(result.algorithm).toBe(CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM);
      expect(result.scope).toBe('final-league-phase');
      expect(result.season).toBe(season);
      expect(result.rows.map(({ teamId }) => teamId)).toEqual(ids);
      expect(
        result.groups.flatMap(({ teamIds }) => teamIds).sort((a, b) => a - b),
      ).toEqual(ids);
      expect(result.groups[0]!.from).toBe(1);
      expect(result.groups.at(-1)!.to).toBe(36);
    },
  );

  // Computed independently in Python from raw scores. In each pair every
  // criterion before key is equal, with the higher ID preferred on key.
  it.each([
    {
      key: 'points',
      equalPrefix: [],
      higher: 4,
      higherValue: 18,
      lower: 1,
      lowerValue: 13,
      seed: 1,
    },
    {
      key: 'goalDifference',
      equalPrefix: [13],
      higher: 18,
      higherValue: 4,
      lower: 1,
      lowerValue: 2,
      seed: 1,
    },
    {
      key: 'goalsFor',
      equalPrefix: [13, 0],
      higher: 25,
      higherValue: 13,
      lower: 14,
      lowerValue: 12,
      seed: 1,
    },
    {
      key: 'awayGoals',
      equalPrefix: [4, -5, 12],
      higher: 25,
      higherValue: 8,
      lower: 1,
      lowerValue: 6,
      seed: 6,
    },
    {
      key: 'won',
      equalPrefix: [10, -3, 11, 7],
      higher: 30,
      higherValue: 3,
      lower: 16,
      lowerValue: 2,
      seed: 115,
    },
    {
      key: 'awayWins',
      equalPrefix: [16, 6, 17, 8, 5],
      higher: 30,
      higherValue: 3,
      lower: 7,
      lowerValue: 2,
      seed: 29,
    },
    {
      key: 'opponentPoints',
      equalPrefix: [9, -4, 11, 8, 3, 2],
      higher: 35,
      higherValue: 104,
      lower: 21,
      lowerValue: 93,
      seed: 39,
    },
    {
      key: 'opponentGoalDifference',
      equalPrefix: [11, 0, 14, 8, 3, 2, 87],
      higher: 32,
      higherValue: -1,
      lower: 31,
      lowerValue: -2,
      seed: 540,
    },
  ] as const)(
    'orders teams $higher and $lower by $key after earlier criteria tie',
    (ref) => {
      const scores = calendar(ref.seed);
      const result = rankChampionsLeaguePhase(table(scores), scores, 2026)!;
      const position = (teamId: number) =>
        result.groups.find((group) => group.teamIds.includes(teamId))!.from;
      expect(result.rows[ref.lower - 1]![ref.key]).toBe(ref.lowerValue);
      expect(result.rows[ref.higher - 1]![ref.key]).toBe(ref.higherValue);
      expect(position(ref.higher)).toBeLessThan(position(ref.lower));
    },
  );

  it('compares opponent goals after their points and goal difference tie', () => {
    const scores = calendar();
    // Club 5 faced 9, but not 10; club 20 faced neither. The 3:3 draw
    // changes only opponent goals of club 5 among the earlier criteria.
    const draw = scores.find(
      (score) => score.homeTeamId === 9 && score.awayTeamId === 10,
    )!;
    draw.homeGoals90 = 3;
    draw.awayGoals90 = 3;
    const result = rankChampionsLeaguePhase(table(scores), scores, 2026)!;
    expect(result.rows[4]).toMatchObject({
      points: 8,
      goalsFor: 0,
      opponentPoints: 64,
      opponentGoalDifference: 0,
      opponentGoalsFor: 3,
    });
    expect(result.rows[19]).toMatchObject({
      points: 8,
      goalsFor: 0,
      opponentPoints: 64,
      opponentGoalDifference: 0,
      opponentGoalsFor: 0,
    });
    const position = (teamId: number) =>
      result.groups.find((group) => group.teamIds.includes(teamId))!.from;
    expect(position(5)).toBeLessThan(position(20));
  });

  it('uses lower disciplinary points before the higher sporting coefficient', () => {
    const scores = calendar();
    const supplied = context({
      34: { clubCoefficient: 100 },
      35: { disciplinaryPoints: 2, clubCoefficient: 1 },
      36: { disciplinaryPoints: 2, clubCoefficient: 1.125 },
    });
    const result = rankChampionsLeaguePhase(table(scores), scores, 2026, supplied)!;
    expect(result.groups.slice(0, 3)).toEqual(
      [36, 35, 34].map((id, index) => ({
        from: index + 1,
        to: index + 1,
        teamIds: [id],
        reason: 'resolved',
        missingCriterion: null,
      })),
    );
    expect(result.groups[3]).toMatchObject({
      from: 4,
      to: 36,
      reason: 'equal-criteria',
      missingCriterion: null,
    });
  });

  it('keeps unknown discipline ahead of coefficient and distinguishes missing coefficient', () => {
    const scores = calendar();
    const rows = table(scores);
    for (const [supplied, criterion] of [
      [
        context({ 35: { disciplinaryPoints: null }, 36: { clubCoefficient: 100 } }),
        'disciplinaryPoints',
      ],
      [context({ 36: { clubCoefficient: null } }), 'clubCoefficient'],
      [[], 'disciplinaryPoints'],
    ] as const) {
      const result = rankChampionsLeaguePhase(rows, scores, 2026, supplied)!;
      expect(result.groups).toEqual([
        {
          from: 1,
          to: 36,
          teamIds: ids,
          reason: 'missing-criterion',
          missingCriterion: criterion,
        },
      ]);
    }
  });

  it('is invariant to transport order and returns independent ranking entries', () => {
    const scores = calendar(540);
    const rows = table(scores);
    const supplied = context({ 36: { disciplinaryPoints: 0, clubCoefficient: 0 } });
    const first = rankChampionsLeaguePhase(rows, scores, 2026, supplied)!;
    const second = rankChampionsLeaguePhase(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
      [...supplied].reverse().map((entry) => Object.freeze(entry)),
    );
    expect(second).toEqual(first);
    expect(first.rows[35]!.clubCoefficient).toBe(0);
    expect(first.rows[35]!.disciplinaryPoints).toBe(0);
    first.rows[35]!.clubCoefficient = 999;
    first.groups[0]!.teamIds.push(999);
    expect(rankChampionsLeaguePhase(rows, scores, 2026, supplied)).toEqual(second);
  });

  it('rejects the old group format, unknown seasons and incomplete or inconsistent phases', () => {
    const scores = calendar(1);
    const rows = table(scores);
    for (const season of [2023, 2027]) {
      expect(rankChampionsLeaguePhase(rows, scores, season)).toBeNull();
    }
    const incomplete = scores.slice(1);
    expect(rankChampionsLeaguePhase(table(incomplete), incomplete, 2026)).toBeNull();
    expect(
      rankChampionsLeaguePhase(
        rows.map((row) => ({ ...row, goalsFor: row.goalsFor + 1 })),
        scores,
        2026,
      ),
    ).toBeNull();
    expect(
      rankChampionsLeaguePhase(
        rows.map((row) => ({ ...row, points: row.points - 1 })),
        scores,
        2026,
      ),
    ).toBeNull();
  });

  it('rejects a repeat opponent even if clubs still have eight games and four home fixtures', () => {
    const scores = calendar();
    const gameOne = scores.find(
      (score) => score.homeTeamId === 1 && score.awayTeamId === 2,
    )!;
    const gameTwo = scores.find(
      (score) => score.homeTeamId === 5 && score.awayTeamId === 6,
    )!;
    // The swap creates 5 vs 2, on top of the existing 2 vs 5.
    [gameOne.awayTeamId, gameTwo.awayTeamId] = [
      gameTwo.awayTeamId,
      gameOne.awayTeamId,
    ];
    expect(rankChampionsLeaguePhase(table(scores), scores, 2026)).toBeNull();
  });

  it('rejects the wrong home/away split even with all distinct opponents', () => {
    const scores = calendar();
    const game = scores[0]!;
    [game.homeTeamId, game.awayTeamId] = [game.awayTeamId, game.homeTeamId];
    expect(rankChampionsLeaguePhase(table(scores), scores, 2026)).toBeNull();
  });

  it('rejects invalid tie-break context and malformed match data', () => {
    const scores = calendar(1);
    const rows = table(scores);
    const valid = { teamId: 1, disciplinaryPoints: 0, clubCoefficient: 1.125 };
    for (const items of [
      [valid, valid],
      [{ ...valid, teamId: 99 }],
      [{ ...valid, disciplinaryPoints: -1 }],
      [{ ...valid, disciplinaryPoints: 0.5 }],
      [{ ...valid, clubCoefficient: NaN }],
      [{ ...valid, clubCoefficient: -1 }],
    ])
      expect(() => rankChampionsLeaguePhase(rows, scores, 2026, items)).toThrow(
        RangeError,
      );
    expect(() => rankChampionsLeaguePhase(rows, scores, 2026.5)).toThrow(RangeError);
    expect(() =>
      rankChampionsLeaguePhase(rows, [...scores.slice(1), scores[1]!], 2026),
    ).toThrow(RangeError);
    expect(() =>
      rankChampionsLeaguePhase(
        rows,
        [{ ...scores[0]!, homeGoals90: -1 }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
  });

  it('rejects an unsafe total for opponents even when individual rows are representable', () => {
    const scores = calendar();
    scores[0]!.homeGoals90 = Number.MAX_SAFE_INTEGER; // 1 vs 2
    scores[16]!.homeGoals90 = Number.MAX_SAFE_INTEGER; // 5 vs 6
    expect(() => rankChampionsLeaguePhase(table(scores), scores, 2026)).toThrow(
      /opponent totals/,
    );
  });
});
