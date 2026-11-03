import 'server-only';

import type { standings } from '@/server/db/schema';

import type { ApiStandingsResponse } from '../schemas/standings';

export function mapStandings({
  competition,
  season,
  standings: apiStandings,
}: ApiStandingsResponse): (typeof standings.$inferInsert)[] {
  const totals = apiStandings.filter((standing) => standing.type === 'TOTAL');
  if (apiStandings.length > 0 && totals.length === 0) {
    throw new Error('Standings response has no TOTAL table');
  }

  const seasonYear = Number(season.startDate.slice(0, 4));
  const teamIds = new Set<number>();

  return totals.flatMap((standing) =>
    standing.table.map((row) => {
      // The DB key allows one row per team in a competition season.
      if (teamIds.has(row.team.id)) {
        throw new Error(
          'Standings response contains a duplicate team in TOTAL tables',
        );
      }
      teamIds.add(row.team.id);

      return {
        competitionId: competition.id,
        season: seasonYear,
        teamId: row.team.id,
        position: row.position,
        playedGames: row.playedGames,
        won: row.won,
        draw: row.draw,
        lost: row.lost,
        points: row.points,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
      };
    }),
  );
}
