import 'server-only';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import { createFootballDataApi } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';

import { parseCompetitionOptions } from './command-options';
import { syncFullCompetitions } from './full';
import { syncCompetitionMatches } from './matches';
import { syncCompetitionScorers } from './scorers';
import { syncCompetitionStandings } from './standings';
import {
  historyCompetitionCodes,
  syncCompetitionStandingsHistory,
} from './standings-history';
import { syncCompetitionTeams } from './teams';

type SeedSyncOptions = {
  historySeasons?: number;
  includeStandingsHistory?: boolean;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

export async function syncSeedCompetitions(
  competitionCodes: readonly string[],
  {
    historySeasons = 3,
    includeStandingsHistory = false,
    signal,
    requestCounter,
  }: SeedSyncOptions = {},
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
  const standingsHistory = [];

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

    const historyCode = includeStandingsHistory
      ? historyCompetitionCodes.find((candidate) => candidate === code)
      : undefined;
    for (const season of seasons) {
      const config = historyCode
        ? getCompetitionSeasonConfig(historyCode, season)
        : undefined;
      if (historyCode && config === undefined) {
        throw new Error('standings history season is not configured');
      }
      const options = { season, signal, requestCounter };
      const teamsResult = await syncCompetitionTeams(code, options);
      const matchesResult = await syncCompetitionMatches(code, options);
      const standingsResult = await syncCompetitionStandings(code, options);
      const scorersResult = await syncCompetitionScorers(code, options);
      if (config) {
        standingsHistory.push(
          await syncCompetitionStandingsHistory(code, {
            ...options,
            throughMatchday: config.matchdays,
          }),
        );
      }

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

  if (includeStandingsHistory) {
    for (const code of historyCompetitionCodes.filter((code) =>
      codes.includes(code),
    )) {
      const competition = await api.getCompetition(code, { signal });
      const season = Number(competition.currentSeason.startDate.slice(0, 4));
      if (season !== currentSeasons.get(code)) {
        throw new Error('competition season changed during seed');
      }
      const config = getCompetitionSeasonConfig(code, season);
      const throughMatchday = competition.currentSeason.currentMatchday;
      if (
        config === undefined ||
        throughMatchday === null ||
        throughMatchday > config.matchdays
      ) {
        throw new Error('current matchday is unavailable for standings history');
      }
      standingsHistory.push(
        throughMatchday === 0
          ? { competitionCode: code, season, snapshots: [] }
          : await syncCompetitionStandingsHistory(code, {
              season,
              throughMatchday,
              signal,
              requestCounter,
            }),
      );
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

  return { ...current, history, standingsHistory };
}
