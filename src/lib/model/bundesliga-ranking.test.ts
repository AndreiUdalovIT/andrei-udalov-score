import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  rankBundesligaSeason,
  BUNDESLIGA_RANKING_ALGORITHM,
} from './bundesliga-ranking';
import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { projectSeasonStats } from './season-stats';

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
  scores: readonly RoundRobinMatchScore[],
  points: ReadonlyMap<number, number> = new Map(),
) {
  const empty = Array.from({ length: 18 }, (_, index) => ({
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
  // Synthetic deductions isolate the compared clubs while the scores retain
  // the required equal overall goal statistics.
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

describe('Bundesliga final-season ranking', () => {
  it.each([2023, 2024, 2025, 2026])(
    'ranks the configured complete season %s and carries its qualification note',
    (season) => {
      const scores = calendar();
      const result = rankBundesligaSeason(table(scores), scores, season)!;
      expect(scores).toHaveLength(306);
      expect(result.algorithm).toBe(BUNDESLIGA_RANKING_ALGORITHM);
      expect(result.season).toBe(season);
      expect(result.qualificationNote).toBe(
        getCompetitionSeasonConfig('BL1', season)!.qualificationNote,
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

  it('puts points ahead of goal difference', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 3, 3, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 50],
        [2, 51],
      ]),
    );
    expect(
      rankBundesligaSeason(rows, scores, 2026)!
        .groups.slice(0, 2)
        .map(({ teamIds }) => teamIds),
    ).toEqual([[2], [1]]);
  });

  it('puts goal difference ahead of goals scored', () => {
    const scores = calendar([
      [1, 3, 2, 0],
      [2, 3, 3, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'table-criteria' },
      { from: 2, to: 2, teamIds: [2], reason: 'table-criteria' },
    ]);
  });

  it('puts goals scored ahead of head-to-head results', () => {
    const scores = calendar([...winningCycle(2, 1, 3), [1, 4, 2, 1]]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      reason: 'table-criteria',
    });
  });

  it('uses the aggregate score when each tied club won a head-to-head match', () => {
    const scores = calendar([
      [1, 2, 4, 0],
      [3, 1, 4, 0],
      [2, 3, 4, 0],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'head-to-head' },
      { from: 2, to: 2, teamIds: [2], reason: 'head-to-head' },
    ]);
  });

  it('puts the aggregate score ahead of head-to-head away goals', () => {
    const scores = calendar([
      [1, 2, 3, 1],
      [3, 1, 2, 0],
      [2, 3, 2, 0],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [1],
      reason: 'head-to-head',
    });
  });

  it('puts head-to-head away goals ahead of all away goals', () => {
    const scores = calendar([
      [1, 2, 2, 1],
      [3, 1, 3, 2],
      [2, 4, 3, 2],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 1,
      teamIds: [2],
      reason: 'head-to-head',
    });
  });

  it('uses all away goals after equal aggregate and head-to-head away goals', () => {
    const scores = calendar([
      [3, 1, 2, 1],
      [2, 4, 2, 1],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 51],
        [2, 51],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups.slice(0, 2)).toEqual([
      { from: 1, to: 1, teamIds: [1], reason: 'all-away-goals' },
      { from: 2, to: 2, teamIds: [2], reason: 'all-away-goals' },
    ]);
  });

  it('applies direct comparison to a mid-table pair', () => {
    const scores = calendar(winningCycle(8, 9, 10));
    const rows = table(scores, new Map([[9, 43]]));
    expect(
      rankBundesligaSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 8,
      ),
    ).toEqual({
      from: 8,
      to: 8,
      teamIds: [8],
      reason: 'head-to-head',
    });
  });

  it('requires a neutral decision game for a fully tied mid-table pair', () => {
    const scores = calendar();
    const rows = table(scores, new Map([[9, 43]]));
    expect(
      rankBundesligaSeason(rows, scores, 2026)!.groups.find(
        ({ from }) => from === 8,
      ),
    ).toEqual({
      from: 8,
      to: 9,
      teamIds: [8, 9],
      reason: 'play-off-required',
    });
  });

  it('retains a multi-team range pending an explicit interpretation of direct comparison', () => {
    const scores = calendar([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
      [4, 1, 4, 0],
      [2, 4, 4, 0],
      [3, 4, 4, 0],
    ]);
    const rows = table(
      scores,
      new Map([
        [1, 48],
        [2, 48],
        [3, 48],
      ]),
    );
    expect(rankBundesligaSeason(rows, scores, 2026)!.groups[0]).toEqual({
      from: 1,
      to: 3,
      teamIds: [1, 2, 3],
      reason: 'rule-interpretation-required',
    });
  });

  it('returns null for incomplete calendars and partial rosters', () => {
    const scores = calendar().slice(1);
    expect(rankBundesligaSeason(table(scores), scores, 2026)).toBeNull();
    const partial = calendar().filter(
      ({ homeTeamId, awayTeamId }) => homeTeamId < 18 && awayTeamId < 18,
    );
    expect(
      rankBundesligaSeason(table(partial).slice(0, 17), partial, 2026),
    ).toBeNull();
  });

  it('rejects duplicate oriented pairs despite reconciled team totals', () => {
    const scores = calendar();
    const index = scores.findIndex(
      ({ homeTeamId, awayTeamId }) => homeTeamId === 2 && awayTeamId === 1,
    );
    scores[index] = { ...scores[index]!, homeTeamId: 1, awayTeamId: 2 };
    expect(rankBundesligaSeason(table(scores), scores, 2026)).toBeNull();
  });

  it('returns null when final stats and the calendar disagree', () => {
    const scores = calendar();
    const rows = table(scores);
    rows[0]!.goalsFor += 1;
    expect(rankBundesligaSeason(rows, scores, 2026)).toBeNull();
  });

  it('handles an unconfigured season and invalid input through the main call', () => {
    expect(rankBundesligaSeason([], [], 2027)).toBeNull();
    expect(() => rankBundesligaSeason([], [], 2026.5)).toThrow(RangeError);
    const scores = calendar();
    const rows = table(scores);
    expect(() =>
      rankBundesligaSeason(
        rows,
        [{ ...scores[0]!, homeGoals90: NaN }, ...scores.slice(1)],
        2026,
      ),
    ).toThrow(RangeError);
    expect(() => rankBundesligaSeason(rows, [scores[0]!, ...scores], 2026)).toThrow(
      RangeError,
    );
  });

  it('validates the shared round-robin format contract', () => {
    for (const format of [
      { teamCount: 0, matchdays: 0 },
      { teamCount: 18, matchdays: 33 },
      { teamCount: Infinity, matchdays: 34 },
    ]) {
      expect(() => reconcileRoundRobinSeason([], [], format)).toThrow(RangeError);
    }
  });

  it('preserves frozen inputs and returns independent canonical results', () => {
    const scores = Object.freeze(
      calendar(winningCycle(1, 2, 3)).map((score) => Object.freeze(score)),
    );
    const rows = Object.freeze(
      table(
        scores,
        new Map([
          [1, 51],
          [2, 51],
        ]),
      ).map((row) => Object.freeze(row)),
    );
    const expected = rankBundesligaSeason(rows, scores, 2026)!;
    const result = rankBundesligaSeason(
      [...rows].reverse(),
      [...scores].reverse(),
      2026,
    )!;
    expect(result).toEqual(expected);
    result.groups[0]!.teamIds.push(999);
    expect(rankBundesligaSeason(rows, scores, 2026)).toEqual(expected);
  });
});
