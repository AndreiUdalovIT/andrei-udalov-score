import 'server-only';

import { and, asc, eq, or } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';
import { selectTrainingMatches } from '@/lib/model/matches';
import {
  calculateRegularizedTeamStrengths,
  type RegularizedStrengthOptions,
} from '@/lib/model/regularized-strengths';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, matches, teamCompetitions } from '../db/schema';

async function getCompetitionStrengthData(
  competitionCode: CompetitionCode,
  season: number,
) {
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
    footballCacheTags.season(competitionCode, season - 1),
  );

  const config = getCompetitionSeasonConfig(competitionCode, season);
  if (!config) return null;
  const previousConfig = getCompetitionSeasonConfig(competitionCode, season - 1);

  try {
    const [participants, seasonMatches] = await db.batch([
      db
        .select({ teamId: teamCompetitions.teamId })
        .from(teamCompetitions)
        .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
        .where(
          and(
            eq(competitions.code, competitionCode),
            eq(teamCompetitions.season, season),
          ),
        )
        .orderBy(asc(teamCompetitions.teamId)),
      db
        .select({
          id: matches.id,
          season: matches.season,
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
          and(
            eq(competitions.code, competitionCode),
            or(
              and(eq(matches.season, season), eq(matches.stage, config.mainStage)),
              previousConfig
                ? and(
                    eq(matches.season, season - 1),
                    eq(matches.stage, previousConfig.mainStage),
                  )
                : undefined,
            ),
          ),
        )
        .orderBy(asc(matches.utcDate), asc(matches.id)),
    ]);

    return {
      teamIds: participants.map((participant) => participant.teamId),
      previousSeason: previousConfig ? season - 1 : null,
      currentMatches: seasonMatches.filter((match) => match.season === season),
      previousMatches: seasonMatches.filter((match) => match.season === season - 1),
    };
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition strength data could not be loaded');
  }
}

/**
 * Current participants, using this and the previous configured season.
 * Only DB inputs are cached; the cutoff and model options apply on every call.
 * The cutoff uses current result records, without historical result versions.
 */
export async function getCompetitionStrengths(
  competitionCode: CompetitionCode,
  season: number,
  before: Date,
  options: RegularizedStrengthOptions,
) {
  const data = await getCompetitionStrengthData(competitionCode, season);
  if (data === null) return null;

  const currentMatches = selectTrainingMatches(data.currentMatches, before);
  const previousMatches = selectTrainingMatches(data.previousMatches, before);
  const strengths = calculateRegularizedTeamStrengths(
    data.teamIds,
    [...previousMatches, ...currentMatches],
    before,
    options,
  );

  return {
    competitionCode,
    season,
    previousSeason: data.previousSeason,
    before,
    sample: {
      currentMatchCount: currentMatches.length,
      previousMatchCount: previousMatches.length,
    },
    ...strengths,
  };
}
