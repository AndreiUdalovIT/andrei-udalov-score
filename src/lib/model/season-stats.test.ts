import { describe, expect, it } from 'vitest';

import type { SeasonFixtureScore } from './season-calendar-sampler';
import { projectSeasonStats, type SeasonStatsBaseline } from './season-stats';

const baseline = Object.freeze([
  Object.freeze({
    teamId: 1,
    playedGames: 2,
    won: 2,
    draw: 0,
    lost: 0,
    points: 3,
    goalsFor: 3,
    goalsAgainst: 0,
  }),
  Object.freeze({
    teamId: 2,
    playedGames: 2,
    won: 0,
    draw: 1,
    lost: 1,
    points: 1,
    goalsFor: 1,
    goalsAgainst: 3,
  }),
  Object.freeze({
    teamId: 3,
    playedGames: 2,
    won: 0,
    draw: 1,
    lost: 1,
    points: 3,
    goalsFor: 1,
    goalsAgainst: 2,
  }),
]);

function score(
  id: number,
  homeTeamId: number,
  awayTeamId: number,
  homeGoals90: number,
  awayGoals90: number,
  source: SeasonFixtureScore['source'],
): Readonly<SeasonFixtureScore> {
  return Object.freeze({
    id,
    homeTeamId,
    awayTeamId,
    homeGoals90,
    awayGoals90,
    source,
  });
}

const known = Object.freeze([
  score(1, 1, 2, 2, 0, 'known-result'),
  score(2, 2, 3, 1, 1, 'known-result'),
  score(3, 3, 1, 0, 1, 'known-result'),
]);
const future = Object.freeze([
  score(4, 2, 1, 2, 1, 'simulated'),
  score(5, 3, 2, 0, 0, 'simulated'),
  score(6, 1, 3, 1, 2, 'simulated'),
]);
const zero = (teamId: number): SeasonStatsBaseline => ({
  teamId,
  playedGames: 0,
  won: 0,
  draw: 0,
  lost: 0,
  points: 0,
  goalsFor: 0,
  goalsAgainst: 0,
});

describe('season statistics projected from an official baseline', () => {
  it('adds only simulated results and preserves deductions and bonuses', () => {
    expect(projectSeasonStats(baseline, [...known, ...future])).toEqual([
      {
        teamId: 1,
        playedGames: 4,
        won: 2,
        draw: 0,
        lost: 2,
        points: 3,
        goalsFor: 5,
        goalsAgainst: 4,
        goalDifference: 1,
        pointsAdjustment: -3,
      },
      {
        teamId: 2,
        playedGames: 4,
        won: 1,
        draw: 2,
        lost: 1,
        points: 5,
        goalsFor: 3,
        goalsAgainst: 4,
        goalDifference: -1,
        pointsAdjustment: 0,
      },
      {
        teamId: 3,
        playedGames: 4,
        won: 1,
        draw: 2,
        lost: 1,
        points: 7,
        goalsFor: 3,
        goalsAgainst: 3,
        goalDifference: 0,
        pointsAdjustment: 2,
      },
    ]);
  });

  it('does not add known results twice when the calendar is completed', () => {
    const rows = projectSeasonStats(baseline, known)!;
    expect(
      rows.map(({ points, pointsAdjustment }) => ({ points, pointsAdjustment })),
    ).toEqual([
      { points: 3, pointsAdjustment: -3 },
      { points: 1, pointsAdjustment: 0 },
      { points: 3, pointsAdjustment: 2 },
    ]);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject(baseline[index]!);
    }
  });

  it('conserves games, goals, outcomes and the added match points', () => {
    const rows = projectSeasonStats(baseline, [...known, ...future])!;
    const sum = (field: keyof SeasonStatsBaseline) =>
      rows.reduce((total, row) => total + row[field], 0);
    expect(sum('playedGames')).toBe(12);
    expect(sum('won')).toBe(sum('lost'));
    expect(sum('draw') % 2).toBe(0);
    expect(sum('goalsFor')).toBe(11);
    expect(sum('goalsAgainst')).toBe(11);
    expect(
      sum('points') - baseline.reduce((total, row) => total + row.points, 0),
    ).toBe(8);
    for (const row of rows) {
      expect(row.points - (3 * row.won + row.draw)).toBe(row.pointsAdjustment);
    }
  });

  it('returns canonical team order for reordered baseline and score inputs', () => {
    const expected = projectSeasonStats(baseline, [...known, ...future]);
    expect(
      projectSeasonStats([...baseline].reverse(), [...future, ...known].reverse()),
    ).toEqual(expected);
  });

  it('keeps inputs intact and returns fresh rows without stale positions or differences', () => {
    const input = baseline.map((row) => ({
      ...row,
      position: 99,
      goalDifference: 999,
      group: 'stale',
    }));
    const first = projectSeasonStats(input, known)!;
    first[0]!.points = 999;
    const second = projectSeasonStats(input, known)!;
    expect(second[0]).toMatchObject({ points: 3, goalDifference: 3 });
    expect(second[0]).not.toHaveProperty('position');
    expect(second[0]).not.toHaveProperty('group');
    expect(input[0]).toMatchObject({ points: 3, position: 99, goalDifference: 999 });
  });

  it('supports empty and preseason tables, including negative official points', () => {
    expect(projectSeasonStats([], [])).toEqual([]);
    const rows = projectSeasonStats(
      [{ ...zero(1), points: -2 }, zero(2)],
      [score(1, 1, 2, 0, 0, 'simulated')],
    )!;
    expect(rows).toEqual([
      {
        ...zero(1),
        playedGames: 1,
        draw: 1,
        points: -1,
        goalDifference: 0,
        pointsAdjustment: -2,
      },
      {
        ...zero(2),
        playedGames: 1,
        draw: 1,
        points: 1,
        goalDifference: 0,
        pointsAdjustment: 0,
      },
    ]);
  });

  it('returns null for missing known games or a baseline that already includes a simulated game', () => {
    expect(projectSeasonStats(baseline, [])).toBeNull();
    expect(projectSeasonStats(baseline, known.slice(1))).toBeNull();
    const later = projectSeasonStats(baseline, [...known, ...future])!;
    expect(projectSeasonStats(later, [...known, ...future])).toBeNull();
  });

  it.each([
    { goalsFor: 4 },
    { goalsAgainst: 1 },
    { won: 1, draw: 1 },
    { won: 1, lost: 1 },
    { playedGames: 3, won: 3 },
  ])('returns null when known results disagree with baseline counts %j', (patch) => {
    expect(
      projectSeasonStats(
        [{ ...baseline[0]!, ...patch }, ...baseline.slice(1)],
        known,
      ),
    ).toBeNull();
  });

  it('validates every score even when the known snapshot is incomplete', () => {
    expect(() =>
      projectSeasonStats(baseline, [score(1, 1, 99, 1, 0, 'simulated')]),
    ).toThrow(RangeError);
    expect(() =>
      projectSeasonStats(baseline, [{ ...known[0]!, awayGoals90: -1 }]),
    ).toThrow(RangeError);
  });

  it('rejects duplicate table teams and duplicate fixture IDs across sources', () => {
    expect(() => projectSeasonStats([baseline[0]!, baseline[0]!], known)).toThrow(
      RangeError,
    );
    expect(() =>
      projectSeasonStats(baseline, [...known, { ...future[0]!, id: 1 }]),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid identifiers %s',
    (id) => {
      expect(() => projectSeasonStats([{ ...zero(1), teamId: id }], [])).toThrow(
        RangeError,
      );
      for (const field of ['id', 'homeTeamId', 'awayTeamId'] as const) {
        expect(() =>
          projectSeasonStats(baseline, [{ ...known[0]!, [field]: id }]),
        ).toThrow(RangeError);
      }
    },
  );

  it('rejects unknown participants and self matches in either score source', () => {
    for (const source of ['known-result', 'simulated'] as const) {
      expect(() =>
        projectSeasonStats(baseline, [score(1, 1, 99, 0, 0, source)]),
      ).toThrow(RangeError);
      expect(() =>
        projectSeasonStats(baseline, [score(1, 99, 1, 0, 0, source)]),
      ).toThrow(RangeError);
      expect(() =>
        projectSeasonStats(baseline, [score(1, 1, 1, 0, 0, source)]),
      ).toThrow(RangeError);
    }
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid non-negative table counters %s',
    (value) => {
      for (const field of [
        'playedGames',
        'won',
        'draw',
        'lost',
        'goalsFor',
        'goalsAgainst',
      ] as const) {
        expect(() =>
          projectSeasonStats([{ ...zero(1), [field]: value }], []),
        ).toThrow(RangeError);
      }
    },
  );

  it.each([
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    -Number.MAX_SAFE_INTEGER - 1,
  ])('rejects invalid official points %s', (points) => {
    expect(() => projectSeasonStats([{ ...zero(1), points }], [])).toThrow(
      RangeError,
    );
  });

  it('rejects internally inconsistent played-game counts', () => {
    expect(() =>
      projectSeasonStats([{ ...zero(1), playedGames: 2, won: 1 }], []),
    ).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid goals %s in known and simulated results',
    (goals) => {
      for (const source of ['known-result', 'simulated'] as const) {
        for (const field of ['homeGoals90', 'awayGoals90'] as const) {
          expect(() =>
            projectSeasonStats(baseline, [{ ...known[0]!, source, [field]: goals }]),
          ).toThrow(RangeError);
        }
      }
    },
  );

  it('rejects an unknown score source', () => {
    const invalid = {
      ...known[0]!,
      source: 'unknown',
    } as unknown as SeasonFixtureScore;
    expect(() => projectSeasonStats(baseline, [invalid])).toThrow(RangeError);
  });

  it('rejects unsafe earned points, adjustments and additions to official points', () => {
    expect(() =>
      projectSeasonStats(
        [
          {
            ...zero(1),
            playedGames: Number.MAX_SAFE_INTEGER,
            won: Number.MAX_SAFE_INTEGER,
          },
        ],
        [],
      ),
    ).toThrow(RangeError);
    expect(() =>
      projectSeasonStats(
        [{ ...zero(1), playedGames: 1, won: 1, points: -Number.MAX_SAFE_INTEGER }],
        [],
      ),
    ).toThrow(RangeError);
    expect(() =>
      projectSeasonStats(
        [{ ...zero(1), points: Number.MAX_SAFE_INTEGER }, zero(2)],
        [score(1, 1, 2, 1, 0, 'simulated')],
      ),
    ).toThrow(RangeError);
  });

  it('rejects overflow in projected goal totals', () => {
    const high = [
      {
        ...zero(1),
        playedGames: 1,
        won: 1,
        points: 3,
        goalsFor: Number.MAX_SAFE_INTEGER,
      },
      { ...zero(2), playedGames: 1, lost: 1, goalsAgainst: Number.MAX_SAFE_INTEGER },
    ];
    const knownHigh = score(1, 1, 2, Number.MAX_SAFE_INTEGER, 0, 'known-result');
    for (const next of [
      score(2, 1, 2, 1, 0, 'simulated'),
      score(2, 2, 1, 0, 1, 'simulated'),
    ]) {
      expect(() => projectSeasonStats(high, [knownHigh, next])).toThrow(RangeError);
    }
  });
});
