import type { MatchStatus } from '@/lib/types/football';

export type VenueMatch = {
  status: MatchStatus;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeGoals90: number | null;
  awayGoals90: number | null;
};

export type VenueStats = {
  teamId: number;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
};

/**
 * The caller scopes matches to one competition, season and table stage.
 * Points use 3/1/0 from played 90-minute results; official ranks and deductions
 * belong to the stored standings. Rows retain the participant order.
 */
export function calculateVenueStats(
  teamIds: readonly number[],
  matches: readonly VenueMatch[],
  venue: 'home' | 'away',
): VenueStats[] {
  const rows = new Map<number, VenueStats>(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        playedGames: 0,
        won: 0,
        draw: 0,
        lost: 0,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
      },
    ]),
  );

  for (const match of matches) {
    const { status, homeTeamId, awayTeamId, homeGoals90, awayGoals90 } = match;
    if (
      status !== 'FINISHED' ||
      homeTeamId === null ||
      awayTeamId === null ||
      homeGoals90 === null ||
      awayGoals90 === null
    ) {
      continue;
    }

    const home = rows.get(homeTeamId);
    const away = rows.get(awayTeamId);
    if (!home || !away) continue;

    const row = venue === 'home' ? home : away;
    const goalsFor = venue === 'home' ? homeGoals90 : awayGoals90;
    const goalsAgainst = venue === 'home' ? awayGoals90 : homeGoals90;

    row.playedGames += 1;
    row.goalsFor += goalsFor;
    row.goalsAgainst += goalsAgainst;
    row.goalDifference += goalsFor - goalsAgainst;

    if (goalsFor > goalsAgainst) {
      row.won += 1;
      row.points += 3;
    } else if (goalsFor === goalsAgainst) {
      row.draw += 1;
      row.points += 1;
    } else {
      row.lost += 1;
    }
  }

  return [...rows.values()];
}
