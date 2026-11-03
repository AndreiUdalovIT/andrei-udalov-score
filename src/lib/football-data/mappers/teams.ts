import 'server-only';

import type { competitions, teamCompetitions, teams } from '@/server/db/schema';

import type { ApiTeamsResponse } from '../schemas/teams';

type CompetitionTeamsRows = {
  competition: typeof competitions.$inferInsert;
  teams: (typeof teams.$inferInsert)[];
  teamCompetitions: (typeof teamCompetitions.$inferInsert)[];
};

type CompetitionTeamsOptions = {
  isCurrentSeason?: boolean;
};

export function mapTeam(
  team: ApiTeamsResponse['teams'][number],
): typeof teams.$inferInsert {
  return {
    id: team.id,
    name: team.name,
    shortName: team.shortName?.trim() || team.name,
    // An empty code leaves the logo placeholder without a label.
    tla: team.tla?.trim() || '',
    crest: team.crest,
    clubColors: team.clubColors,
  };
}

export function mapCompetitionTeams(
  { competition, season, teams: apiTeams }: ApiTeamsResponse,
  { isCurrentSeason = false }: CompetitionTeamsOptions = {},
): CompetitionTeamsRows {
  const seasonYear = Number(season.startDate.slice(0, 4));

  return {
    competition: {
      id: competition.id,
      code: competition.code,
      name: competition.name,
      emblem: competition.emblem,
      // Historical seasons must not replace the competition's current matchday.
      ...(isCurrentSeason ? { currentMatchday: season.currentMatchday } : {}),
    },
    teams: apiTeams.map(mapTeam),
    teamCompetitions: apiTeams.map((team) => ({
      competitionId: competition.id,
      season: seasonYear,
      teamId: team.id,
    })),
  };
}
