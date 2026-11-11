import { describe, expect, it } from 'vitest';

import type { ModelMatch } from './matches';
import { calculateTeamStrengths } from './team-strengths';

const before = new Date('2026-11-11T12:00:00Z');
const match: ModelMatch = {
  id: 1,
  status: 'FINISHED',
  utcDate: new Date('2026-11-10T12:00:00Z'),
  lastUpdated: new Date('2026-11-10T14:00:00Z'),
  homeTeamId: 1,
  awayTeamId: 2,
  homeGoals90: 4,
  awayGoals90: 1,
};

describe('team strength coefficients', () => {
  it('uses weighted league baselines and the correct venue without mutation', () => {
    const rows = Object.freeze([
      Object.freeze(match),
      Object.freeze({
        ...match,
        id: 2,
        utcDate: new Date('2026-11-09T12:00:00Z'),
        lastUpdated: new Date('2026-11-09T14:00:00Z'),
        homeTeamId: 2,
        awayTeamId: 1,
        homeGoals90: 2,
        awayGoals90: 3,
      }),
      Object.freeze({
        ...match,
        id: 3,
        homeTeamId: 3,
        awayTeamId: 4,
        homeGoals90: 0,
        awayGoals90: 0,
      }),
    ]);

    expect(calculateTeamStrengths(Object.freeze([1]), rows, before, 1)).toEqual({
      league: {
        matchCount: 3,
        effectiveMatchCount: 25 / 9,
        homeGoalsPerMatch: 2,
        awayGoalsPerMatch: 1,
      },
      teams: [
        {
          teamId: 1,
          home: { matchCount: 1, effectiveMatchCount: 1, attack: 2, defence: 1 },
          away: { matchCount: 1, effectiveMatchCount: 1, attack: 3, defence: 1 },
        },
      ],
    });
  });

  it('reports the effective sample separately for home and away matches', () => {
    const rows = [
      match,
      {
        ...match,
        id: 2,
        utcDate: new Date('2026-11-09T12:00:00Z'),
        lastUpdated: new Date('2026-11-09T14:00:00Z'),
      },
      { ...match, id: 3, homeTeamId: 2, awayTeamId: 1 },
    ];
    const team = calculateTeamStrengths([1], rows, before, 1).teams[0];

    expect(team?.home?.matchCount).toBe(2);
    expect(team?.home?.effectiveMatchCount).toBeCloseTo(1.8, 12);
    expect(team?.away?.matchCount).toBe(1);
    expect(team?.away?.effectiveMatchCount).toBe(1);
  });

  it('preserves participant order, deduplicates IDs and retains missing venues', () => {
    const result = calculateTeamStrengths([2, 1, 2, 99], [match], before, 1);

    expect(result.teams).toEqual([
      {
        teamId: 2,
        home: null,
        away: { matchCount: 1, effectiveMatchCount: 1, attack: 1, defence: 1 },
      },
      {
        teamId: 1,
        home: { matchCount: 1, effectiveMatchCount: 1, attack: 1, defence: 1 },
        away: null,
      },
      { teamId: 99, home: null, away: null },
    ]);
  });

  it('keeps zero coefficients and returns null for zero league baselines', () => {
    const zeroDraw = { ...match, homeGoals90: 0, awayGoals90: 0 };

    expect(calculateTeamStrengths([1], [zeroDraw], before, 1).teams).toEqual([
      {
        teamId: 1,
        home: { matchCount: 1, effectiveMatchCount: 1, attack: null, defence: null },
        away: null,
      },
    ]);

    const result = calculateTeamStrengths(
      [1],
      [
        zeroDraw,
        {
          ...match,
          id: 2,
          homeTeamId: 3,
          awayTeamId: 4,
          homeGoals90: 2,
          awayGoals90: 2,
        },
      ],
      before,
      1,
    );

    expect(result.teams[0]?.home).toEqual({
      matchCount: 1,
      effectiveMatchCount: 1,
      attack: 0,
      defence: 0,
    });
  });

  it('retains participants when the training sample is empty', () => {
    expect(calculateTeamStrengths([1, 2], [], before, 1)).toEqual({
      league: null,
      teams: [
        { teamId: 1, home: null, away: null },
        { teamId: 2, home: null, away: null },
      ],
    });
  });

  it('returns null when a relative coefficient exceeds the numeric range', () => {
    const rows = [
      {
        ...match,
        utcDate: new Date(before.getTime() - 1_071 * 86_400_000),
        lastUpdated: new Date(before.getTime() - 1_071 * 86_400_000 + 7_200_000),
        homeGoals90: 1,
      },
      { ...match, id: 2, homeTeamId: 3, awayTeamId: 4, homeGoals90: 0 },
    ];

    expect(calculateTeamStrengths([1], rows, before, 1).teams[0]?.home).toEqual({
      matchCount: 1,
      effectiveMatchCount: 1,
      attack: null,
      defence: 1,
    });
  });
});
