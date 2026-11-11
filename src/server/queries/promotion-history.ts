import 'server-only';

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, matches, teamCompetitions } from '../db/schema';

/**
 * PL newcomers with ELC membership in the preceding season, and both leagues'
 * main-stage matches. The model applies its cutoff to these current records.
 * Calibration callers select an earlier PL season than the one being predicted.
 */
export async function getPromotionHistory(premierLeagueSeason: number) {
  'use cache';

  const championshipSeason = premierLeagueSeason - 1;
  cacheLife('minutes');
  cacheTag(
    footballCacheTags.competition('PL'),
    footballCacheTags.competition('ELC'),
    footballCacheTags.season('PL', premierLeagueSeason),
    footballCacheTags.season('PL', championshipSeason),
    footballCacheTags.season('ELC', championshipSeason),
  );

  const premierLeagueConfig = getCompetitionSeasonConfig('PL', premierLeagueSeason);
  const championshipConfig = getCompetitionSeasonConfig('ELC', championshipSeason);
  if (!premierLeagueConfig || !championshipConfig) return null;

  try {
    const [participants, seasonMatches] = await db.batch([
      db
        .select({
          competitionCode: competitions.code,
          season: teamCompetitions.season,
          teamId: teamCompetitions.teamId,
        })
        .from(teamCompetitions)
        .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
        .where(
          or(
            and(
              eq(competitions.code, 'PL'),
              inArray(teamCompetitions.season, [
                championshipSeason,
                premierLeagueSeason,
              ]),
            ),
            and(
              eq(competitions.code, 'ELC'),
              eq(teamCompetitions.season, championshipSeason),
            ),
          ),
        )
        .orderBy(asc(teamCompetitions.teamId)),
      db
        .select({
          competitionCode: competitions.code,
          id: matches.id,
          status: matches.status,
          utcDate: matches.utcDate,
          lastUpdated: matches.lastUpdated,
          homeTeamId: matches.homeTeamId,
          awayTeamId: matches.awayTeamId,
          homeGoals90: matches.homeGoals90,
          awayGoals90: matches.awayGoals90,
        })
        .from(matches)
        .innerJoin(competitions, eq(matches.competitionId, competitions.id))
        .where(
          or(
            and(
              eq(competitions.code, 'PL'),
              eq(matches.season, premierLeagueSeason),
              eq(matches.stage, premierLeagueConfig.mainStage),
            ),
            and(
              eq(competitions.code, 'ELC'),
              eq(matches.season, championshipSeason),
              eq(matches.stage, championshipConfig.mainStage),
            ),
          ),
        )
        .orderBy(asc(matches.utcDate), asc(matches.id)),
    ]);

    const previousPremierLeagueTeams = new Set(
      participants
        .filter(
          (team) =>
            team.competitionCode === 'PL' && team.season === championshipSeason,
        )
        .map((team) => team.teamId),
    );
    const championshipTeams = new Set(
      participants
        .filter((team) => team.competitionCode === 'ELC')
        .map((team) => team.teamId),
    );
    const promotedTeamIds = participants
      .filter(
        (team) =>
          team.competitionCode === 'PL' &&
          team.season === premierLeagueSeason &&
          championshipTeams.has(team.teamId) &&
          !previousPremierLeagueTeams.has(team.teamId),
      )
      .map((team) => team.teamId);

    return {
      premierLeagueSeason,
      championshipSeason,
      promotedTeamIds,
      premierLeagueMatches: seasonMatches.filter(
        (match) => match.competitionCode === 'PL',
      ),
      championshipMatches: seasonMatches.filter(
        (match) => match.competitionCode === 'ELC',
      ),
    };
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('promotion history could not be loaded');
  }
}
