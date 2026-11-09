import 'server-only';

import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';
import { calculateVenueStats } from '@/lib/football/venue-stats';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, matches, teamCompetitions, teams } from '../db/schema';

const stageByFormat = {
  'round-robin': 'REGULAR_SEASON',
  groups: 'GROUP_STAGE',
  'league-phase': 'LEAGUE_STAGE',
} as const;

/** Main-stage statistics; null means the season format is not configured. */
export async function getCompetitionVenueStats(
  competitionCode: CompetitionCode,
  season: number,
  venue: 'home' | 'away',
) {
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.teams,
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
  );

  const config = getCompetitionSeasonConfig(competitionCode, season);
  if (!config) return null;

  try {
    const [participants, seasonMatches] = await db.batch([
      db
        .select(getTableColumns(teams))
        .from(teamCompetitions)
        .innerJoin(teams, eq(teamCompetitions.teamId, teams.id))
        .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
        .where(
          and(
            eq(competitions.code, competitionCode),
            eq(teamCompetitions.season, season),
          ),
        )
        .orderBy(asc(teams.shortName), asc(teams.id)),
      db
        .select({
          status: matches.status,
          homeTeamId: matches.homeTeamId,
          awayTeamId: matches.awayTeamId,
          homeGoals90: matches.homeGoals90,
          awayGoals90: matches.awayGoals90,
        })
        .from(matches)
        .innerJoin(competitions, eq(matches.competitionId, competitions.id))
        .where(
          and(
            eq(competitions.code, competitionCode),
            eq(matches.season, season),
            eq(matches.stage, stageByFormat[config.format]),
          ),
        ),
    ]);

    const statsByTeam = new Map(
      calculateVenueStats(
        participants.map((team) => team.id),
        seasonMatches,
        venue,
      ).map((stats) => [stats.teamId, stats]),
    );

    return participants.map((team) => {
      const stats = statsByTeam.get(team.id);
      if (!stats) throw new Error('Missing participant statistics');
      return { ...stats, team };
    });
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition venue statistics could not be loaded');
  }
}
