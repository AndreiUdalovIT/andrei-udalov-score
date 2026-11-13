import 'server-only';

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';
import { calculateExpectedGoals } from '@/lib/model/expected-goals';
import {
  compareGoalForecasts,
  type GoalForecastCandidate,
} from '@/lib/model/goal-comparison';
import {
  buildWalkForwardGoalForecasts,
  type GoalValidationWindow,
} from '@/lib/model/goal-walk-forward';
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
        .select({
          teamId: teamCompetitions.teamId,
          season: teamCompetitions.season,
        })
        .from(teamCompetitions)
        .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
        .where(
          and(
            eq(competitions.code, competitionCode),
            inArray(teamCompetitions.season, [season - 1, season]),
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
      teamIds: participants
        .filter((participant) => participant.season === season)
        .map((participant) => participant.teamId),
      previousTeamIds: participants
        .filter((participant) => participant.season === season - 1)
        .map((participant) => participant.teamId),
      previousSeason: previousConfig ? season - 1 : null,
      currentMatches: seasonMatches.filter((match) => match.season === season),
      previousMatches: seasonMatches.filter((match) => match.season === season - 1),
    };
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition strength data could not be loaded');
  }
}

async function loadCompetitionStrengthInputs(
  competitionCode: CompetitionCode,
  season: number,
) {
  const data = await getCompetitionStrengthData(competitionCode, season);
  if (data === null) return null;

  const [history, calibration] =
    competitionCode === 'PL'
      ? await Promise.all([
          getPromotionHistory(season),
          getPromotionHistory(season - 1),
        ])
      : [null, null];
  return { ...data, competitionCode, season, history, calibration };
}

type CompetitionStrengthInputs = NonNullable<
  Awaited<ReturnType<typeof loadCompetitionStrengthInputs>>
>;

function calculatePremierLeaguePromotionStrengths(
  data: CompetitionStrengthInputs,
  premierLeagueMatches: readonly ModelMatch[],
  before: Date,
  options: PromotionAdjustmentOptions,
) {
  const { history, calibration } = data;
  const previousTeamIds = new Set(history?.previousPremierLeagueTeamIds ?? []);
  const newcomerTeamIds = data.teamIds.filter(
    (teamId) => !previousTeamIds.has(teamId),
  );
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

function calculateCompetitionStrengths(
  data: CompetitionStrengthInputs,
  before: Date,
  options: PromotionAdjustmentOptions,
) {
  const { competitionCode, season } = data;
  const currentMatches = selectTrainingMatches(data.currentMatches, before);
  const previousMatches = selectTrainingMatches(data.previousMatches, before);
  const trainingMatches = [...previousMatches, ...currentMatches];
  const previousTeamIds = new Set(data.previousTeamIds);
  const teamsWithoutPreviousMembership = data.teamIds.filter(
    (teamId) => !previousTeamIds.has(teamId),
  );
  const teamsRequiringHistory = new Set(teamsWithoutPreviousMembership);
  const strengths = calculateRegularizedTeamStrengths(
    data.teamIds,
    trainingMatches,
    before,
    options,
  );
  const promotion =
    competitionCode === 'PL'
      ? calculatePremierLeaguePromotionStrengths(
          data,
          trainingMatches,
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
    history: {
      previousParticipantCount: previousTeamIds.size,
      teamsWithoutPreviousMembership,
    },
    teams: strengths.teams.map((team) => {
      const promoted = promotedByTeam.get(team.teamId);
      if (promoted) return promoted;

      const requiresHistory =
        competitionCode === 'CL' || teamsRequiringHistory.has(team.teamId);
      return {
        ...team,
        home: requiresHistory && team.home?.lowData ? null : team.home,
        away: requiresHistory && team.away?.lowData ? null : team.away,
      };
    }),
    promotion: promotion?.details ?? null,
  };
}

/**
 * Current participants, using this and the previous configured season.
 * Only DB inputs are cached; the cutoff and model options apply on every call.
 * The cutoff uses current result records, without historical result versions.
 * Domestic newcomers require sufficient native venue history unless a PL
 * newcomer has a usable adjusted ELC prior.
 * CL requires sufficient history in its own main stages for every team.
 */
export async function getCompetitionStrengths(
  competitionCode: CompetitionCode,
  season: number,
  before: Date,
  options: PromotionAdjustmentOptions,
) {
  const data = await loadCompetitionStrengthInputs(competitionCode, season);
  return data === null ? null : calculateCompetitionStrengths(data, before, options);
}

export type StrengthValidationCandidate = {
  id: string;
  options: PromotionAdjustmentOptions;
};

/**
 * Compare a season's main-stage forecasts using one set of loaded DB inputs.
 * Each fixture uses its kickoff as the exclusive training cutoff.
 * Earlier result revisions require separately captured versions.
 * The caller selects tuning and final evaluation periods separately.
 */
export async function getCompetitionStrengthValidation(
  competitionCode: CompetitionCode,
  season: number,
  window: GoalValidationWindow,
  candidates: readonly StrengthValidationCandidate[],
) {
  if (candidates.length === 0) {
    throw new RangeError('at least one strength validation candidate is required');
  }
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
  ) {
    throw new RangeError('forecast candidate IDs must be unique');
  }

  const settings = candidates.map(({ id, options }) => ({
    id,
    options: { ...options },
  }));
  const period = {
    from: new Date(window.from.getTime()),
    until: new Date(window.until.getTime()),
    resultsBefore: new Date(window.resultsBefore.getTime()),
  };
  const data = await loadCompetitionStrengthInputs(competitionCode, season);
  if (data === null) return null;

  const forecasts: GoalForecastCandidate[] = [];
  for (const candidate of settings) {
    const rows = await buildWalkForwardGoalForecasts(
      data.currentMatches,
      period,
      ({ homeTeamId, awayTeamId, before }) => {
        const strengths = calculateCompetitionStrengths(
          data,
          before,
          candidate.options,
        );
        const home = strengths.teams.find((team) => team.teamId === homeTeamId);
        const away = strengths.teams.find((team) => team.teamId === awayTeamId);
        return calculateExpectedGoals(
          strengths.league,
          home?.home ?? null,
          away?.away ?? null,
        );
      },
    );
    forecasts.push({ id: candidate.id, rows });
  }

  const comparison = compareGoalForecasts(forecasts);
  return {
    competitionCode,
    season,
    previousSeason: data.previousSeason,
    window: period,
    ...comparison,
    candidates: comparison.candidates.map((candidate, index) => ({
      ...candidate,
      options: settings[index]!.options,
    })),
  };
}
