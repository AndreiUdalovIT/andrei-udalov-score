import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import {
  siteCompetitionCodes,
  type SiteCompetitionCode,
} from '@/lib/config/competitions';
import type { Zone } from '@/lib/types/football';

import type { SeasonStatsBaseline } from './season-stats';

export const LEAGUE_FORECAST_ACCUMULATION_ALGORITHM =
  'complete-league-empirical-summary-v1';
export const LEAGUE_POINTS_INTERVAL_METHOD = 'inverse-empirical-cdf-10-90-v1';

export type LeagueForecastPoints = Readonly<
  Pick<SeasonStatsBaseline, 'teamId' | 'points'>
>;

export type LeagueForecastPositionGroup = {
  readonly from: number;
  readonly to: number;
  readonly teamIds: readonly number[];
};

export type LeagueTeamForecast = {
  teamId: number;
  expectedPoints: number;
  pointsInterval80: { lower: number; upper: number };
  positionDistribution: {
    position: number;
    count: number;
    probability: number;
  }[];
  /** One entry per configured range, including separate entries with the same zone. */
  zones: {
    from: number;
    to: number;
    zone: Zone;
    label: string;
    count: number;
    probability: number;
  }[];
};

export type LeagueForecastSummary = {
  algorithm: typeof LEAGUE_FORECAST_ACCUMULATION_ALGORITHM;
  pointsIntervalMethod: typeof LEAGUE_POINTS_INTERVAL_METHOD;
  competitionCode: SiteCompetitionCode;
  season: number;
  runs: number;
  qualificationNote: string | null;
  teams: LeagueTeamForecast[];
};

export type LeagueForecastAccumulator = {
  readonly algorithm: typeof LEAGUE_FORECAST_ACCUMULATION_ALGORITHM;
  readonly targetRuns: number;
  readonly completedRuns: number;
  readonly status: 'collecting' | 'complete' | 'failed';
  readonly addRun: (
    points: readonly LeagueForecastPoints[],
    groups: readonly LeagueForecastPositionGroup[],
  ) => void;
  readonly summarize: () => LeagueForecastSummary | null;
};

function empiricalQuantile(
  bins: readonly (readonly [number, number])[],
  rank: number,
): number {
  let count = 0;
  for (const [points, frequency] of bins) {
    count += frequency;
    if (count >= rank) return points;
  }
  throw new RangeError('point histogram does not cover the requested sample rank');
}

/**
 * Accumulate a fixed number of complete league scenarios, without sampling them.
 * Support configured site round-robin leagues; return null for other formats or
 * unconfigured seasons. Validate a fixed positive safe-integer roster and run count.
 * Each run must contain every club once, safe integer points (including deductions),
 * and every position once in singleton groups. Ranking reasons are not interpreted;
 * the caller resolves all football rules and reconciles season stats beforehand.
 * Validate a run before updating any statistics. An invalid/unresolved run marks
 * the accumulator failed, keeps its completed count and permanently withholds the
 * summary. Do not discard such runs and resample: that would condition the forecast.
 * Summaries are available only after exactly targetRuns accepted scenarios.
 * Extra submissions after completion throw without changing the completed summary.
 * Point sums use private BigInts; divide quotient/remainder to return Number means.
 * The interval uses inverse empirical CDF ranks ceil(n/10) and ceil(9n/10).
 * Discrete samples can put more than 80% of observations inside these endpoints.
 * Zone probabilities mean occupying each configured position range. Preserve its
 * label and qualification note; no cup outcomes or extra UEFA slots are inferred.
 * The caller retains seed, sampling/ranking/model versions, cutoff and establishes
 * scenario independence. Fresh summaries contain only JSON-compatible values.
 */
export function createLeagueForecastAccumulator(
  competitionCode: SiteCompetitionCode,
  season: number,
  teamIds: readonly number[],
  targetRuns: number,
): LeagueForecastAccumulator | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  if (!Number.isSafeInteger(targetRuns) || targetRuns <= 0) {
    throw new RangeError('target runs must be a positive safe integer');
  }
  if (!siteCompetitionCodes.includes(competitionCode)) return null;
  const config = getCompetitionSeasonConfig(competitionCode, season);
  if (config === undefined || config.format !== 'round-robin') return null;
  const teamCount = config.teamCount;
  if (!Number.isSafeInteger(teamCount) || teamCount < 2) {
    throw new RangeError(
      'configured league size must be a positive safe integer above one',
    );
  }
  const ids = Array.from(teamIds).sort((left, right) => left - right);
  const roster = new Set(ids);
  if (
    ids.length !== teamCount ||
    roster.size !== teamCount ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new RangeError(
      'roster must contain the configured number of unique positive safe team IDs',
    );
  }
  const zones = config.zones.map((zone) => ({ ...zone }));
  for (const zone of zones) {
    if (
      !Number.isSafeInteger(zone.from) ||
      !Number.isSafeInteger(zone.to) ||
      zone.from < 1 ||
      zone.to < zone.from ||
      zone.to > teamCount
    ) {
      throw new RangeError(
        'configured zones must be valid inclusive league positions',
      );
    }
  }
  const qualificationNote = config.qualificationNote;
  const states = ids.map((teamId) => ({
    teamId,
    pointSum: BigInt(0),
    pointHistogram: new Map<number, number>(),
    positions: Array<number>(teamCount).fill(0),
  }));
  let completed = 0;
  let failed = false;

  function prepareRun(
    points: readonly LeagueForecastPoints[],
    groups: readonly LeagueForecastPositionGroup[],
  ) {
    const rows = Array.from(points);
    const ranking = Array.from(groups);
    if (rows.length !== teamCount || ranking.length !== teamCount) {
      throw new RangeError(
        'each run requires the complete roster and singleton position groups',
      );
    }
    const pointMap = new Map<number, number>();
    for (const row of rows) {
      if (
        row === undefined ||
        row === null ||
        !roster.has(row.teamId) ||
        pointMap.has(row.teamId) ||
        !Number.isSafeInteger(row.points)
      ) {
        throw new RangeError(
          'run points require unique roster IDs and safe integer totals',
        );
      }
      pointMap.set(row.teamId, row.points);
    }
    const positions = new Map<number, number>();
    const seenPositions = new Set<number>();
    for (const group of ranking) {
      if (
        group === undefined ||
        group === null ||
        !Number.isSafeInteger(group.from) ||
        group.from < 1 ||
        group.from > teamCount ||
        group.to !== group.from ||
        group.teamIds.length !== 1 ||
        !roster.has(group.teamIds[0]!) ||
        positions.has(group.teamIds[0]!) ||
        seenPositions.has(group.from)
      ) {
        throw new RangeError(
          'run ranking requires every club and position once with no unresolved range',
        );
      }
      seenPositions.add(group.from);
      positions.set(group.teamIds[0]!, group.from);
    }
    return ids.map((teamId) => ({
      points: pointMap.get(teamId)!,
      position: positions.get(teamId)!,
    }));
  }

  return {
    algorithm: LEAGUE_FORECAST_ACCUMULATION_ALGORITHM,
    targetRuns,
    get completedRuns() {
      return completed;
    },
    get status() {
      return failed
        ? 'failed'
        : completed === targetRuns
          ? 'complete'
          : 'collecting';
    },
    addRun(points, groups) {
      if (failed)
        throw new RangeError('cannot add runs to a failed forecast accumulator');
      if (completed === targetRuns)
        throw new RangeError('forecast accumulator is already complete');
      let prepared: ReturnType<typeof prepareRun>;
      try {
        prepared = prepareRun(points, groups);
      } catch (error) {
        failed = true;
        throw error;
      }
      prepared.forEach((row, index) => {
        const state = states[index]!;
        state.pointSum += BigInt(row.points);
        state.pointHistogram.set(
          row.points,
          (state.pointHistogram.get(row.points) ?? 0) + 1,
        );
        state.positions[row.position - 1]! += 1;
      });
      completed += 1;
    },
    summarize() {
      if (failed || completed !== targetRuns) return null;
      const total = BigInt(completed);
      const lowerRank = Number((total + BigInt(9)) / BigInt(10));
      const upperRank = Number((total * BigInt(9) + BigInt(9)) / BigInt(10));
      return {
        algorithm: LEAGUE_FORECAST_ACCUMULATION_ALGORITHM,
        pointsIntervalMethod: LEAGUE_POINTS_INTERVAL_METHOD,
        competitionCode,
        season,
        runs: completed,
        qualificationNote,
        teams: states.map((state) => {
          const bins = [...state.pointHistogram.entries()].sort(
            (left, right) => left[0] - right[0],
          );
          return {
            teamId: state.teamId,
            expectedPoints:
              Number(state.pointSum / total) +
              Number(state.pointSum % total) / completed,
            pointsInterval80: {
              lower: empiricalQuantile(bins, lowerRank),
              upper: empiricalQuantile(bins, upperRank),
            },
            positionDistribution: state.positions.map((count, index) => ({
              position: index + 1,
              count,
              probability: count / completed,
            })),
            zones: zones.map((zone) => {
              const count = state.positions
                .slice(zone.from - 1, zone.to)
                .reduce((sum, value) => sum + value, 0);
              return { ...zone, count, probability: count / completed };
            }),
          };
        }),
      };
    },
  };
}
