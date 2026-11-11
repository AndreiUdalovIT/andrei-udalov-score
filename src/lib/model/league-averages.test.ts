import { describe, expect, it } from 'vitest';

import { calculateLeagueAverages } from './league-averages';
import type { ModelMatch } from './matches';

const before = new Date('2026-11-11T12:00:00Z');

function finishedMatch(
  id: number,
  daysAgo: number,
  homeGoals90: number,
  awayGoals90: number,
): ModelMatch {
  const utcDate = new Date(before.getTime() - daysAgo * 86_400_000);

  return {
    id,
    status: 'FINISHED',
    utcDate,
    lastUpdated: new Date(utcDate.getTime() + 7_200_000),
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals90,
    awayGoals90,
  };
}

describe('league goal averages', () => {
  it('weights older matches by the chosen half-life without mutating inputs', () => {
    const rows = Object.freeze([
      Object.freeze(finishedMatch(1, 1, 2, 0)),
      Object.freeze(finishedMatch(2, 2, 0, 3)),
    ]);

    expect(calculateLeagueAverages(rows, before, 1)).toEqual({
      matchCount: 2,
      effectiveMatchCount: 1.8,
      homeGoalsPerMatch: 4 / 3,
      awayGoalsPerMatch: 1,
    });

    const slowerDecay = calculateLeagueAverages(rows, before, 2);

    expect(slowerDecay?.homeGoalsPerMatch).toBeCloseTo(2 / (1 + Math.SQRT1_2), 12);
    expect(slowerDecay?.awayGoalsPerMatch).toBeCloseTo(
      (3 * Math.SQRT1_2) / (1 + Math.SQRT1_2),
      12,
    );
  });

  it('counts equally weighted matches at their full sample size', () => {
    const rows = [
      finishedMatch(1, 1, 2, 1),
      finishedMatch(2, 1, 1, 2),
      finishedMatch(3, 1, 0, 0),
    ];

    expect(calculateLeagueAverages(rows, before, 1)).toEqual({
      matchCount: 3,
      effectiveMatchCount: 3,
      homeGoalsPerMatch: 1,
      awayGoalsPerMatch: 1,
    });
  });

  it('keeps zero goals and applies training selection before averaging', () => {
    const zeroDraw = finishedMatch(1, 1, 0, 0);
    const ignored: ModelMatch[] = [
      { ...finishedMatch(2, 1, 99, 99), status: 'AWARDED' },
      { ...finishedMatch(3, 1, 99, 99), lastUpdated: before },
    ];

    expect(calculateLeagueAverages([zeroDraw, ...ignored], before, 1)).toEqual({
      matchCount: 1,
      effectiveMatchCount: 1,
      homeGoalsPerMatch: 0,
      awayGoalsPerMatch: 0,
    });
  });

  it('returns null when the sample is empty', () => {
    expect(calculateLeagueAverages([], before, 1)).toBeNull();
  });

  it('keeps decay stable for old and dominated samples', () => {
    const rows = [finishedMatch(1, 2_000, 2, 1)];
    const expected = {
      matchCount: 1,
      effectiveMatchCount: 1,
      homeGoalsPerMatch: 2,
      awayGoalsPerMatch: 1,
    };

    expect(calculateLeagueAverages(rows, before, 1)).toEqual(expected);
    expect(calculateLeagueAverages(rows, before, Number.MIN_VALUE)).toEqual(
      expected,
    );

    expect(
      calculateLeagueAverages(
        [...rows, finishedMatch(2, 1, 0, 2)],
        before,
        Number.MIN_VALUE,
      ),
    ).toEqual({
      matchCount: 2,
      effectiveMatchCount: 1,
      homeGoalsPerMatch: 0,
      awayGoalsPerMatch: 2,
    });
  });

  it('rejects invalid half-lives and cutoffs even for empty samples', () => {
    for (const halfLifeDays of [0, -1, NaN, Infinity]) {
      expect(() => calculateLeagueAverages([], before, halfLifeDays)).toThrow(
        RangeError,
      );
    }

    expect(() => calculateLeagueAverages([], new Date(NaN), 1)).toThrow(RangeError);
  });
});
