import 'server-only';

import { and, asc, eq, or } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';
import { selectTrainingMatches, type ModelMatch } from '@/lib/model/matches';
import { calculatePromotedTeamStrengths } from '@/lib/model/promoted-strengths';
import {
  estimatePromotionAdjustment,
  type PromotionAdjustmentOptions,
} from '@/lib/model/promotion-adjustment';
import { calculateRegularizedTeamStrengths } from '@/lib/model/regularized-strengths';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, matches, teamCompetitions } from '../db/schema';
import { getPromotionHistory } from './promotion-history';

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

async function getPremierLeaguePromotionStrengths(
  teamIds: readonly number[],
  premierLeagueMatches: readonly ModelMatch[],
  season: number,
  before: Date,
  options: PromotionAdjustmentOptions,
) {
  const [history, calibration] = await Promise.all([
    getPromotionHistory(season),
    getPromotionHistory(season - 1),
  ]);
  const previousTeamIds = new Set(history?.previousPremierLeagueTeamIds ?? []);
  const newcomerTeamIds = teamIds.filter((teamId) => !previousTeamIds.has(teamId));
  const adjustment = estimatePromotionAdjustment(
    calibration?.promotedTeamIds ?? [],
    calibration?.championshipMatches ?? [],
    calibration?.premierLeagueMatches ?? [],
    before,
    options,
  );
  const strengths = calculatePromotedTeamStrengths(
    newcomerTeamIds,
    history?.championshipMatches ?? [],
    premierLeagueMatches,
    before,
    adjustment,
    options,
  );

  return {
    teams: strengths.teams,
    details: {
      championshipSeason: history?.championshipSeason ?? null,
      calibrationSeason: calibration?.premierLeagueSeason ?? null,
      previousPremierLeagueTeamCount: previousTeamIds.size,
      adjustment,
    },
  };
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
  options: PromotionAdjustmentOptions,
) {
  const data = await getCompetitionStrengthData(competitionCode, season);
  if (data === null) return null;

  const currentMatches = selectTrainingMatches(data.currentMatches, before);
  const previousMatches = selectTrainingMatches(data.previousMatches, before);
  const trainingMatches = [...previousMatches, ...currentMatches];
  const strengths = calculateRegularizedTeamStrengths(
    data.teamIds,
    trainingMatches,
    before,
    options,
  );
  const promotion =
    competitionCode === 'PL'
      ? await getPremierLeaguePromotionStrengths(
          data.teamIds,
          trainingMatches,
          season,
          before,
          options,
        )
      : null;
  const promotedByTeam = new Map(
    promotion?.teams.map((team) => [team.teamId, team]) ?? [],
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
    teams: strengths.teams.map((team) => promotedByTeam.get(team.teamId) ?? team),
    promotion: promotion?.details ?? null,
  };
}
