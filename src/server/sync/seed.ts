import 'server-only';

import { createFootballDataApi } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';

import { parseCompetitionOptions } from './command-options';
import { syncFullCompetitions } from './full';
import { syncCompetitionMatches } from './matches';
import { syncCompetitionScorers } from './scorers';
import { syncCompetitionStandings } from './standings';
import { syncCompetitionTeams } from './teams';

type SeedSyncOptions = {
  historySeasons?: number;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

export async function syncSeedCompetitions(
  competitionCodes: readonly string[],
  { historySeasons = 3, signal, requestCounter }: SeedSyncOptions = {},
) {
  if (competitionCodes.length === 0) {
    throw new Error('At least one competition is required');
  }
  if (!Number.isSafeInteger(historySeasons) || historySeasons < 0) {
    throw new RangeError('historySeasons must be a non-negative safe integer');
  }

  const codes = [
    ...new Set(
      competitionCodes.map(
        (competition) => parseCompetitionOptions({ competition }).competitionCode,
      ),
    ),
  ];
  const api = createFootballDataApi({ requestCounter });
  const currentSeasons = new Map<string, number>();
  const history = [];

  for (const code of codes) {
    const competition = await api.getCompetition(code, { signal });
    const currentSeason = Number(competition.currentSeason.startDate.slice(0, 4));
    currentSeasons.set(code, currentSeason);
    const seasons = [
      ...new Set(
        competition.seasons.map((season) => Number(season.startDate.slice(0, 4))),
      ),
    ]
      .filter((season) => season < currentSeason)
      .sort((left, right) => right - left)
      .slice(0, historySeasons)
      .reverse();

    for (const season of seasons) {
      const options = { season, signal, requestCounter };
      const teamsResult = await syncCompetitionTeams(code, options);
      const matchesResult = await syncCompetitionMatches(code, options);
      const standingsResult = await syncCompetitionStandings(code, options);
      const scorersResult = await syncCompetitionScorers(code, options);

      history.push({
        competitionCode: teamsResult.competitionCode,
        season,
        teamCount: teamsResult.teamCount,
        matchCount: matchesResult.matchCount,
        standingsCount: standingsResult.rowCount,
        scorerCount: scorersResult.rowCount,
      });
    }
  }

  // Restore current metadata and squads after importing historical seasons.
  const current = await syncFullCompetitions(codes, { signal, requestCounter });
  if (
    current.competitions.some(
      (competition) =>
        competition.season !== currentSeasons.get(competition.competitionCode),
    )
  ) {
    throw new Error('competition season changed during seed');
  }

  return { ...current, history };
}
