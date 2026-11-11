import { describe, expect, it } from 'vitest';

import { calculateVenueStats, type VenueMatch } from './venue-stats';

const emptyStats = {
  playedGames: 0,
  won: 0,
  draw: 0,
  lost: 0,
  points: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  goalDifference: 0,
};

function finishedMatch(
  homeTeamId: number,
  awayTeamId: number,
  homeGoals90: number,
  awayGoals90: number,
): VenueMatch {
  return { status: 'FINISHED', homeTeamId, awayTeamId, homeGoals90, awayGoals90 };
}

const teamIds = Object.freeze([1, 2, 3]);
const matches = Object.freeze([
  Object.freeze(finishedMatch(1, 2, 2, 0)),
  Object.freeze(finishedMatch(2, 1, 1, 1)),
  Object.freeze(finishedMatch(2, 1, 0, 3)),
]);

describe('venue statistics', () => {
  it('counts home results and retains an unplayed team without mutating inputs', () => {
    expect(calculateVenueStats(teamIds, matches, 'home')).toEqual([
      {
        ...emptyStats,
        teamId: 1,
        playedGames: 1,
        won: 1,
        points: 3,
        goalsFor: 2,
        goalDifference: 2,
      },
      {
        ...emptyStats,
        teamId: 2,
        playedGames: 2,
        draw: 1,
        lost: 1,
        points: 1,
        goalsFor: 1,
        goalsAgainst: 4,
        goalDifference: -3,
      },
      { teamId: 3, ...emptyStats },
    ]);
  });

  it('reverses the goals and outcomes for away results', () => {
    expect(calculateVenueStats(teamIds, matches, 'away')).toEqual([
      {
        ...emptyStats,
        teamId: 1,
        playedGames: 2,
        won: 1,
        draw: 1,
        points: 4,
        goalsFor: 4,
        goalsAgainst: 1,
        goalDifference: 3,
      },
      {
        ...emptyStats,
        teamId: 2,
        playedGames: 1,
        lost: 1,
        goalsAgainst: 2,
        goalDifference: -2,
      },
      { teamId: 3, ...emptyStats },
    ]);
  });

  it.each(['home', 'away'] as const)(
    'skips unplayed, awarded, incomplete and out-of-scope matches for %s',
    (venue) => {
      const match = finishedMatch(1, 2, 2, 1);
      const ignored: VenueMatch[] = [
        ...(['TIMED', 'IN_PLAY', 'AWARDED'] as const).map((status) => ({
          ...match,
          status,
        })),
        { ...match, homeGoals90: null },
        { ...match, awayGoals90: null },
        { ...match, homeTeamId: null },
        { ...match, awayTeamId: null },
        { ...match, homeTeamId: 99 },
        { ...match, awayTeamId: 99 },
      ];

      expect(calculateVenueStats([1, 2], ignored, venue)).toEqual([
        { teamId: 1, ...emptyStats },
        { teamId: 2, ...emptyStats },
      ]);
    },
  );

  it('counts a 0–0 draw using the 90-minute score rather than shootout goals', () => {
    const match = { ...finishedMatch(1, 2, 0, 0), homeGoals: 5, awayGoals: 4 };

    expect(calculateVenueStats([1, 2], [match], 'home')).toEqual([
      { ...emptyStats, teamId: 1, playedGames: 1, draw: 1, points: 1 },
      { teamId: 2, ...emptyStats },
    ]);
  });

  it('returns zeroes for known participants before any matches have been played', () => {
    expect(calculateVenueStats([2, 1], [], 'home')).toEqual([
      { teamId: 2, ...emptyStats },
      { teamId: 1, ...emptyStats },
    ]);
    expect(calculateVenueStats([], [], 'away')).toEqual([]);
  });
});
