import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  rankPremierLeagueSeason,
  PREMIER_LEAGUE_RANKING_ALGORITHM,
  type PremierLeagueMatchScore,
} from './premier-league-ranking';
import { projectSeasonStats } from './season-stats';

type Override = readonly [
  home: number,
  away: number,
  homeGoals: number,
  awayGoals: number,
];

function calendar(overrides: readonly Override[] = []): PremierLeagueMatchScore[] {
  const changed = new Map(
    overrides.map(([home, away, homeGoals90, awayGoals90]) => [
      `${home}:${away}`,
      { homeGoals90, awayGoals90 },
    ]),
  );
  const scores: PremierLeagueMatchScore[] = [];
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
  scores: readonly PremierLeagueMatchScore[],
  points: ReadonlyMap<number, number> = new Map(),
) {
  const empty = Array.from({ length: 20 }, (_, index) => ({
    teamId: index + 1,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  const rows = projectSeasonStats(
    empty,
    scores.map((score) => ({
      ...score,
      source: 'simulated' as const,
    })),
  )!;
  // Synthetic point deductions select table positions while balanced match
  // cycles retain equal overall goals for the clubs under comparison.
  return rows.map((row) => ({
    ...row,
    points: points.get(row.teamId) ?? row.points - row.teamId,
  }));
}

function winningCycle(a: number, b: number, c: number): Override[] {
  return [
    [b, a, 0, 1],
    [a, c, 0, 1],
    [c, b, 0, 1],
  ];
}

function partialSplit(a: number, b: number, c: number, other: number): Override[] {
  return [
    [b, a, 0, 1],
    [c, a, 0, 1],
    [other, a, 4, 0],
    [b, other, 4, 0],
    [c, other, 4, 0],
  ];
}

describe('Premier League final-season ranking', () => {
  it('ranks the complete table and carries configured qualification assumptions', () => {
    const scores = calendar();
    const result = rankPremierLeagueSeason(table(scores), scores, 2026)!;
    expect(result.algorithm).toBe(PREMIER_LEAGUE_RANKING_ALGORITHM);
    expect(result.season).toBe(2026);
    expect(result.decisiveBoundaries).toEqual([1, 4, 5, 17]);
    expect(result.qualificationNote).toBe(
      getCompetitionSeasonConfig('PL', 2026)!.qualificationNote,
    );
    expect(result.groups).toEqual(
      Array.from({ length: 20 }, (_, index) => ({
        from: index + 1,
        to: index + 1,
        teamIds: [index + 1],
        reason: 'table-criteria',
      })),
    );
  });

  it('puts points ahead of a superior goal difference', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 3, 3, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 56],
        [2, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [2], reason: 'table-criteria' },
      { from: 2, to: 2, teamIds: [1], reason: 'table-criteria' },
    ]);
  });

  it('puts goal difference ahead of the number of goals scored', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 3, 3, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'table-criteria' },
      { from: 2, to: 2, teamIds: [2], reason: 'table-criteria' },
    ]);
  });

  it('uses goals scored before a superior head-to-head record', () => {
    const scores = calendar([...winningCycle(2, 1, 3), [1, 4, 2, 1]]);
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'table-criteria' },
      { from: 2, to: 2, teamIds: [2], reason: 'table-criteria' },
    ]);
  });

  it('uses head-to-head points at the championship boundary', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
      ]),
    );
    const result = rankPremierLeagueSeason(rows, scores, 2026)!;
    expect(result.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head' },
    ]);
  });

  it('uses away goals in head-to-head matches after equal head-to-head points', () => {
    const scores = calendar([[1, 2, 2, 1]]);
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [2], reason: 'head-to-head' },
      { from: 2, to: 2, teamIds: [1], reason: 'head-to-head' },
    ]);
  });

  it('requires a play-off when points and head-to-head away goals remain equal', () => {
    // A's larger head-to-head goal difference is outside the C.17 criteria.
    const scores = calendar([
      [1, 2, 4, 0],
      [3, 1, 4, 0],
      [2, 3, 4, 0],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 2,
      teamIds: [1, 2],
      reason: 'play-off-required',
    });
  });

  it('preserves shared mid-table positions even when head-to-head results differ', () => {
    const scores = calendar(winningCycle(8, 9, 10));
    const rows = table(scores, new Map([[9, 49]]));
    expect(
      rankPremierLeagueSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 8,
      ),
    ).toEqual({
      from: 8,
      to: 9,
      teamIds: [8, 9],
      reason: 'shared-position',
    });
  });

  it.each([
    { season: 2023, reason: 'head-to-head', uclEnd: 4 },
    { season: 2024, reason: 'shared-position', uclEnd: 5 },
    { season: 2025, reason: 'shared-position', uclEnd: 5 },
    { season: 2026, reason: 'head-to-head', uclEnd: 4 },
  ])(
    'uses the configured qualification boundary for $season',
    ({ season, reason, uclEnd }) => {
      const scores = calendar(winningCycle(4, 5, 6));
      const rows = table(scores, new Map([[5, 53]]));
      const result = rankPremierLeagueSeason(rows, scores, season)!;
      expect(result.decisiveBoundaries).toContain(uclEnd);
      expect(result.groups.find(({ from }) => from === 4)!.reason).toBe(reason);
    },
  );

  it('uses head-to-head results between safety and relegation', () => {
    const scores = calendar(winningCycle(17, 18, 19));
    const rows = table(scores, new Map([[18, 40]]));
    expect(
      rankPremierLeagueSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 17,
      ),
    ).toEqual({
      from: 17,
      to: 17,
      teamIds: [17],
      reason: 'head-to-head',
    });
  });

  it('shares positions inside the relegation zone', () => {
    const scores = calendar(winningCycle(18, 19, 20));
    const rows = table(scores, new Map([[19, 39]]));
    expect(
      rankPremierLeagueSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 18,
      ),
    ).toEqual({
      from: 18,
      to: 19,
      teamIds: [18, 19],
      reason: 'shared-position',
    });
  });

  it('reports a larger decisive tie for a League decision', () => {
    const scores = calendar(winningCycle(1, 2, 3));
    const rows = table(
      scores,
      new Map([
        [1, 57],
        [2, 57],
        [3, 57],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 3,
      teamIds: [1, 2, 3],
      reason: 'league-decision-required',
    });
  });

  it('uses the original tied group for head-to-head away goals after a partial split', () => {
    const scores = calendar([
      [1, 2, 3, 2],
      [2, 1, 0, 1],
      [3, 1, 0, 1],
      [2, 3, 2, 1],
      [4, 1, 5, 0],
      [2, 4, 3, 0],
      [3, 4, 5, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 54],
        [2, 54],
        [3, 54],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 3)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head' },
      { from: 3, to: 3, teamIds: [3], reason: 'head-to-head' },
    ]);
  });

  it('shares a remaining tie once the decisive boundary has been resolved', () => {
    const scores = calendar(partialSplit(1, 2, 3, 4));
    const rows = table(
      scores,
      new Map([
        [1, 54],
        [2, 54],
        [3, 54],
      ]),
    );
    expect(rankPremierLeagueSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head' },
      { from: 2, to: 3, teamIds: [2, 3], reason: 'shared-position' },
    ]);
  });

  it('rechecks qualification boundaries using the positions after a partial split', () => {
    const scores = calendar(partialSplit(4, 5, 6, 7));
    const rows = table(
      scores,
      new Map([
        [4, 53],
        [5, 53],
        [6, 53],
      ]),
    );
    expect(
      rankPremierLeagueSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 5,
      ),
    ).toEqual({
      from: 5,
      to: 6,
      teamIds: [5, 6],
      reason: 'play-off-required',
    });
  });

  it('returns null for incomplete match data or a partial roster', () => {
    const scores = calendar().slice(1);
    expect(rankPremierLeagueSeason(table(scores), scores, 2026)).toBeNull();
    const partial = calendar().filter(
      ({ homeTeamId, awayTeamId }) => homeTeamId < 20 && awayTeamId < 20,
    );
    expect(
      rankPremierLeagueSeason(table(partial).slice(0, 19), partial, 2026),
    ).toBeNull();
  });

  it('returns null for duplicate oriented pairs despite reconciled table totals', () => {
    const scores = calendar();
    const index = scores.findIndex(
      ({ homeTeamId, awayTeamId }) => homeTeamId === 2 && awayTeamId === 1,
    );
    scores[index] = { ...scores[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(rankPremierLeagueSeason(table(scores), scores, 2026)).toBeNull();
  });

  it('returns null when the match snapshot and final table disagree', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(rankPremierLeagueSeason(rows, scores, 2026)).toBeNull();
  });

  it('handles unconfigured seasons and rejects invalid season values', () => {
    expect(rankPremierLeagueSeason([], [], 2027)).toBeNull();
    expect(() => rankPremierLeagueSeason([], [], 2026.5)).toThrow(RangeError);
  });

  it('validates malformed inputs through the normal ranking entry point', () => {
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      rankPremierLeagueSeason(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() =>
      rankPremierLeagueSeason(rows, [scores[0]!, ...scores], 2026),
    ).toThrow(RangeError);
    expect(() => rankPremierLeagueSeason([rows[0]!, ...rows], scores, 2026)).toThrow(
      RangeError,
    );
    expect(() =>
      rankPremierLeagueSeason(
        rows,
        [{ ...scores[0]!, homeTeamId: 99 }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
  });

  it('preserves frozen input and returns independent results in canonical order', () => {
    const scores = Object.freeze(
      calendar(winningCycle(1, 2, 3)).map((score) => Object.freeze(score)),
    );
    const rows = Object.freeze(
      table(
        scores,
        new Map([
          [1, 57],
          [2, 57],
        ]),
      ).map((row) => Object.freeze(row)),
    );
    const expected = rankPremierLeagueSeason(rows, scores, 2026)!;
    const result = rankPremierLeagueSeason(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
    )!;
    expect(result).toEqual(expected);
    result.groups[0]!.teamIds.push(999);
    result.decisiveBoundaries.push(999);
    expect(rankPremierLeagueSeason(rows, scores, 2026)).toEqual(expected);
  });
});
