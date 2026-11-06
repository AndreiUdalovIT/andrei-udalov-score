import 'server-only';

import type { ClientOptions } from '@/lib/football-data/client';

import { parseCompetitionOptions } from './command-options';
import { syncCompetitionMatches } from './matches';
import { syncCompetitionScorers } from './scorers';
import { syncCompetitionStandings } from './standings';
import { syncCompetitionTeams } from './teams';

type LightSyncOptions = {
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

export async function syncLightCompetitions(
  competitionCodes: readonly string[],
  { signal, requestCounter }: LightSyncOptions = {},
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
  const now = Date.now();
  const weekMs = 7 * 86_400_000;
  // One UTC window for the whole run, including both boundary dates.
  const dateFrom = new Date(now - weekMs).toISOString().slice(0, 10);
  const dateTo = new Date(now + weekMs).toISOString().slice(0, 10);
  const competitions = [];

  for (const code of codes) {
    const teamsResult = await syncCompetitionTeams(code, {
      signal,
      requestCounter,
    });
    const seasonOptions = { season: teamsResult.season, signal, requestCounter };
    const matchesResult = await syncCompetitionMatches(code, {
      ...seasonOptions,
      dateFrom,
      dateTo,
    });
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
  }

  return { dateFrom, dateTo, competitions };
}
