import 'server-only';

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';
import { strengthModelOptions } from '@/lib/config/model-strengths';
import {
  calculateExpectedGoals,
  type ExpectedGoals,
} from '@/lib/model/expected-goals';
import {
  compareGoalForecasts,
  type GoalForecastCandidate,
} from '@/lib/model/goal-comparison';
import {
  buildWalkForwardGoalForecasts,
  type GoalValidationWindow,
  type WalkForwardGoalRow,
} from '@/lib/model/goal-walk-forward';
import {
  RECONSTRUCTED_RESULT_DELAY_HOURS,
  reconstructResultAvailability,
  selectTrainingMatches,
  type ModelMatch,
} from '@/lib/model/matches';
import { isPrematchFixture } from '@/lib/model/prediction-eligibility';
import { calculatePromotedTeamStrengths } from '@/lib/model/promoted-strengths';
import {
  estimatePromotionAdjustment,
  type PromotionAdjustmentOptions,
} from '@/lib/model/promotion-adjustment';
import { calculateRegularizedTeamStrengths } from '@/lib/model/regularized-strengths';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, matches, teamCompetitions } from '../db/schema';
import { loadMatchObservations } from './match-observations';
import { getPromotionHistory, loadPromotionHistory } from './promotion-history';

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

  return loadCompetitionStrengthData(competitionCode, season);
}

async function loadCompetitionStrengthData(
  competitionCode: CompetitionCode,
  season: number,
) {
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
  cacheInputs = true,
) {
  const data = await (cacheInputs
    ? getCompetitionStrengthData(competitionCode, season)
    : loadCompetitionStrengthData(competitionCode, season));
  if (data === null) return null;

  const loadHistory = cacheInputs ? getPromotionHistory : loadPromotionHistory;
  const [history, calibration] =
    competitionCode === 'PL'
      ? await Promise.all([loadHistory(season), loadHistory(season - 1)])
      : [null, null];
  return { ...data, competitionCode, season, history, calibration };
}

type ObservedStrengthMatch = ModelMatch & {
  competitionCode: string;
  season: number;
  stage: string;
};

function observedTeamIds(matches: readonly ModelMatch[]) {
  const ids = matches
    .flatMap((match) => [match.homeTeamId, match.awayTeamId])
    .filter((id): id is number => id !== null);
  return [...new Set(ids)].sort((first, second) => first - second);
}

function selectObservedStrengthData(
  records: readonly ObservedStrengthMatch[],
  competitionCode: CompetitionCode,
  season: number,
  mainStage: string,
) {
  const current = records.filter(
    (match) => match.competitionCode === competitionCode && match.season === season,
  );
  const previous = records.filter(
    (match) =>
      match.competitionCode === competitionCode && match.season === season - 1,
  );
  const previousConfig = getCompetitionSeasonConfig(competitionCode, season - 1);
  return {
    teamIds: observedTeamIds(current),
    previousTeamIds: observedTeamIds(previous),
    previousSeason: previousConfig ? season - 1 : null,
    currentMatches: current.filter((match) => match.stage === mainStage),
    previousMatches: previous.filter(
      (match) => match.stage === previousConfig?.mainStage,
    ),
  };
}

function selectObservedPromotionHistory(
  records: readonly ObservedStrengthMatch[],
  premierLeagueSeason: number,
) {
  const championshipSeason = premierLeagueSeason - 1;
  const premierLeagueConfig = getCompetitionSeasonConfig('PL', premierLeagueSeason);
  const championshipConfig = getCompetitionSeasonConfig('ELC', championshipSeason);
  if (!premierLeagueConfig || !championshipConfig) return null;

  const premierLeague = selectObservedStrengthData(
    records,
    'PL',
    premierLeagueSeason,
    premierLeagueConfig.mainStage,
  );
  const championship = selectObservedStrengthData(
    records,
    'ELC',
    championshipSeason,
    championshipConfig.mainStage,
  );
  const previousTeams = new Set(premierLeague.previousTeamIds);
  const championshipTeams = new Set(championship.teamIds);
  return {
    premierLeagueSeason,
    championshipSeason,
    previousPremierLeagueTeamIds: premierLeague.previousTeamIds,
    promotedTeamIds: premierLeague.teamIds.filter(
      (teamId) => championshipTeams.has(teamId) && !previousTeams.has(teamId),
    ),
    premierLeagueMatches: premierLeague.currentMatches,
    championshipMatches: championship.currentMatches,
  };
}

type CompetitionStrengthInputs = NonNullable<
  Awaited<ReturnType<typeof loadCompetitionStrengthInputs>>
>;

function reconstructPromotionHistory(history: CompetitionStrengthInputs['history']) {
  if (!history) return history;
  return {
    ...history,
    premierLeagueMatches: reconstructResultAvailability(
      history.premierLeagueMatches,
    ),
    championshipMatches: reconstructResultAvailability(history.championshipMatches),
  };
}

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
  options: PromotionAdjustmentOptions = strengthModelOptions[competitionCode],
) {
  const data = await loadCompetitionStrengthInputs(competitionCode, season);
  return data === null ? null : calculateCompetitionStrengths(data, before, options);
}

/**
 * Read current DB inputs directly for jobs running after synchronization.
 * Result availability still uses the latest API update on each stored match.
 */
export async function loadCompetitionStrengths(
  competitionCode: CompetitionCode,
  season: number,
  before: Date,
  options: PromotionAdjustmentOptions = strengthModelOptions[competitionCode],
) {
  const data = await loadCompetitionStrengthInputs(competitionCode, season, false);
  return data === null ? null : calculateCompetitionStrengths(data, before, options);
}

async function loadObservedStrengthInputs(
  competitionCode: CompetitionCode,
  season: number,
  cutoff: Date,
) {
  const config = getCompetitionSeasonConfig(competitionCode, season);
  if (!config) return null;

  const includePromotion = competitionCode === 'PL';
  const rows = await loadMatchObservations(
    includePromotion ? ['PL', 'ELC'] : [competitionCode],
    includePromotion ? [season - 2, season - 1, season] : [season - 1, season],
    cutoff,
  );
  const records: ObservedStrengthMatch[] = rows.map(
    ({ competitionCode, observation }) => ({
      competitionCode,
      id: observation.matchId,
      season: observation.season,
      stage: observation.stage,
      status: observation.status,
      utcDate: observation.utcDate,
      lastUpdated: observation.lastUpdated,
      observedAt: observation.observedAt,
      homeTeamId: observation.homeTeamId,
      awayTeamId: observation.awayTeamId,
      homeGoals90: observation.homeGoals90,
      awayGoals90: observation.awayGoals90,
    }),
  );
  const data = selectObservedStrengthData(
    records,
    competitionCode,
    season,
    config.mainStage,
  );
  return {
    ...data,
    competitionCode,
    season,
    history: includePromotion
      ? selectObservedPromotionHistory(records, season)
      : null,
    calibration: includePromotion
      ? selectObservedPromotionHistory(records, season - 1)
      : null,
  };
}

/**
 * Rebuild strengths from the states observed strictly before the cutoff.
 * Observed fixtures define participants and recorded receipt times define
 * result availability. One SQL snapshot covers the competition and PL/ELC
 * promotion cohorts. Season configuration scopes each training main stage.
 */
export async function loadObservedCompetitionStrengthSnapshot(
  competitionCode: CompetitionCode,
  season: number,
  before: Date,
  options: PromotionAdjustmentOptions = strengthModelOptions[competitionCode],
) {
  const cutoff = new Date(before.getTime());
  if (!Number.isFinite(cutoff.getTime())) {
    throw new RangeError('before must be a valid date');
  }
  const settings = { ...options };
  const data = await loadObservedStrengthInputs(competitionCode, season, cutoff);
  if (data === null) return null;

  return {
    matches: data.currentMatches,
    strengths: calculateCompetitionStrengths(data, cutoff, settings),
  };
}

export async function loadObservedCompetitionStrengths(
  competitionCode: CompetitionCode,
  season: number,
  before: Date,
  options: PromotionAdjustmentOptions = strengthModelOptions[competitionCode],
) {
  const snapshot = await loadObservedCompetitionStrengthSnapshot(
    competitionCode,
    season,
    before,
    options,
  );
  return snapshot?.strengths ?? null;
}

export type ObservedGoalForecastRow = WalkForwardGoalRow & {
  homeTeamId: number;
  awayTeamId: number;
};

export type StrengthValidationCandidate = {
  id: string;
  options: PromotionAdjustmentOptions;
};

async function loadCurrentStrengthForecasts(
  competitionCode: CompetitionCode,
  season: number,
  period: GoalValidationWindow,
  settings: readonly StrengthValidationCandidate[],
  availability: 'api-update' | 'reconstructed',
) {
  const source = await loadCompetitionStrengthInputs(competitionCode, season);
  if (source === null) return null;
  const data =
    availability === 'reconstructed'
      ? {
          ...source,
          currentMatches: reconstructResultAvailability(source.currentMatches),
          previousMatches: reconstructResultAvailability(source.previousMatches),
          history: reconstructPromotionHistory(source.history),
          calibration: reconstructPromotionHistory(source.calibration),
        }
      : source;

  const forecasts: GoalForecastCandidate[] = [];
  for (const candidate of settings) {
    const rows = await buildWalkForwardGoalForecasts(
      source.currentMatches,
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

  return { previousSeason: data.previousSeason, forecasts };
}

async function loadObservedStrengthForecasts(
  competitionCode: CompetitionCode,
  season: number,
  period: GoalValidationWindow,
  settings: readonly StrengthValidationCandidate[],
) {
  const source = await loadObservedStrengthInputs(
    competitionCode,
    season,
    period.resultsBefore,
  );
  if (source === null) return null;

  const predictionsByMatch = new Map<
    number,
    {
      homeTeamId: number;
      awayTeamId: number;
      goals: readonly (ExpectedGoals | null)[];
    }
  >();
  let inputCutoff: number | undefined;
  let currentInputs: CompetitionStrengthInputs | null = null;
  const forecasts: { id: string; rows: ObservedGoalForecastRow[] }[] = [];
  for (const [index, candidate] of settings.entries()) {
    const rows = await buildWalkForwardGoalForecasts(
      source.currentMatches,
      period,
      async ({ id, homeTeamId, awayTeamId, before }) => {
        let saved = predictionsByMatch.get(id);
        if (saved === undefined) {
          if (inputCutoff !== before.getTime()) {
            currentInputs = await loadObservedStrengthInputs(
              competitionCode,
              season,
              before,
            );
            inputCutoff = before.getTime();
          }
          const data = currentInputs;
          const fixture = data?.currentMatches.find((match) => match.id === id);
          let predictions: (ExpectedGoals | null)[] = settings.map(() => null);
          if (
            data !== null &&
            fixture !== undefined &&
            isPrematchFixture(fixture) &&
            fixture.utcDate.getTime() === before.getTime() &&
            fixture.homeTeamId === homeTeamId &&
            fixture.awayTeamId === awayTeamId
          ) {
            predictions = settings.map(({ options }) => {
              const strengths = calculateCompetitionStrengths(data, before, options);
              const home = strengths.teams.find(
                (team) => team.teamId === homeTeamId,
              );
              const away = strengths.teams.find(
                (team) => team.teamId === awayTeamId,
              );
              return calculateExpectedGoals(
                strengths.league,
                home?.home ?? null,
                away?.away ?? null,
              );
            });
          }
          saved = { homeTeamId, awayTeamId, goals: predictions };
          predictionsByMatch.set(id, saved);
        }
        return saved.goals[index] ?? null;
      },
    );
    forecasts.push({
      id: candidate.id,
      rows: rows.map((row) => {
        const fixture = predictionsByMatch.get(row.id)!;
        return {
          ...row,
          homeTeamId: fixture.homeTeamId,
          awayTeamId: fixture.awayTeamId,
        };
      }),
    });
  }
  return { previousSeason: source.previousSeason, forecasts };
}

/** Observed walk-forward rows with the fixture identity needed for storage. */
export async function loadObservedCompetitionGoalForecasts(
  competitionCode: CompetitionCode,
  season: number,
  window: GoalValidationWindow,
  options: PromotionAdjustmentOptions = strengthModelOptions[competitionCode],
) {
  const period = {
    from: new Date(window.from.getTime()),
    until: new Date(window.until.getTime()),
    resultsBefore: new Date(window.resultsBefore.getTime()),
  };
  const settings = { ...options };
  const source = await loadObservedStrengthForecasts(
    competitionCode,
    season,
    period,
    [{ id: 'observed', options: settings }],
  );
  if (source === null) return null;
  return {
    competitionCode,
    season,
    previousSeason: source.previousSeason,
    window: period,
    options: settings,
    resultAvailability: { mode: 'observed' as const, delayHours: null },
    rows: source.forecasts[0]?.rows ?? [],
  };
}

/**
 * Compare a season's main-stage forecasts with exclusive kickoff cutoffs.
 * Observed mode replays captured states and requires a known prematch fixture.
 * Its candidates share one input snapshot per kickoff and observed outcomes.
 * API and reconstructed modes use current DB records for validation outcomes.
 * Reconstructed training availability assumes final scores after 24 hours.
 * The caller selects tuning and final evaluation periods separately.
 */
export async function getCompetitionStrengthValidation(
  competitionCode: CompetitionCode,
  season: number,
  window: GoalValidationWindow,
  candidates: readonly StrengthValidationCandidate[],
  availability: 'api-update' | 'reconstructed' | 'observed' = 'api-update',
) {
  if (
    availability !== 'api-update' &&
    availability !== 'reconstructed' &&
    availability !== 'observed'
  ) {
    throw new RangeError('unsupported result availability mode');
  }
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
  const source =
    availability === 'observed'
      ? await loadObservedStrengthForecasts(
          competitionCode,
          season,
          period,
          settings,
        )
      : await loadCurrentStrengthForecasts(
          competitionCode,
          season,
          period,
          settings,
          availability,
        );
  if (source === null) return null;

  const comparison = compareGoalForecasts(source.forecasts);
  return {
    competitionCode,
    season,
    previousSeason: source.previousSeason,
    window: period,
    resultAvailability: {
      mode: availability,
      delayHours:
        availability === 'reconstructed' ? RECONSTRUCTED_RESULT_DELAY_HOURS : null,
    },
    ...comparison,
    candidates: comparison.candidates.map((candidate, index) => ({
      ...candidate,
      options: settings[index]!.options,
    })),
  };
}
