import 'server-only';

import { parseCompetitionOptions } from './command-options';
import { syncCompetitionMatches } from './matches';
import { syncCompetitionScorers } from './scorers';
import { syncTeamSquad } from './squad';
import { syncCompetitionStandings } from './standings';
import { syncCompetitionTeams } from './teams';

type FullSyncOptions = {
  signal?: AbortSignal;
};

export async function syncFullCompetitions(
  competitionCodes: readonly string[],
  { signal }: FullSyncOptions = {},
) {
  if (competitionCodes.length === 0) {
    throw new Error('At least one competition is required');
  }

  const codes = [
    ...new Set(
      competitionCodes.map(
        (competition) => parseCompetitionOptions({ competition }).competitionCode,
      ),
    ),
  ];
  const competitions = [];
  const teamIds = new Set<number>();

  for (const code of codes) {
    const teamsResult = await syncCompetitionTeams(code, { signal });
    const seasonOptions = { season: teamsResult.season, signal };
    const matchesResult = await syncCompetitionMatches(code, seasonOptions);
    const standingsResult = await syncCompetitionStandings(code, seasonOptions);
    const scorersResult = await syncCompetitionScorers(code, seasonOptions);

    competitions.push({
      competitionCode: teamsResult.competitionCode,
      season: teamsResult.season,
      teamCount: teamsResult.teamCount,
      matchCount: matchesResult.matchCount,
      standingsCount: standingsResult.rowCount,
      scorerCount: scorersResult.rowCount,
    });
    for (const teamId of teamsResult.teamIds) {
      teamIds.add(teamId);
    }
  }

  for (const teamId of teamIds) {
    await syncTeamSquad(teamId, { signal });
  }

  return { competitions, squadCount: teamIds.size };
}
