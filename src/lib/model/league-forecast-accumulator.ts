import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import {
  siteCompetitionCodes,
  type SiteCompetitionCode,
} from '@/lib/config/competitions';
import type { Zone } from '@/lib/types/football';

import type { SeasonStatsBaseline } from './season-stats';

export const LEAGUE_FORECAST_ACCUMULATION_ALGORITHM =
  'complete-league-empirical-summary-v3';
export const LEAGUE_POINTS_INTERVAL_METHOD = 'inverse-empirical-cdf-10-90-v1';

export type LeagueForecastPoints = Readonly<
  Pick<SeasonStatsBaseline, 'teamId' | 'points'>
>;

export type LeagueForecastPositionGroup = {
  readonly from: number;
  readonly to: number;
  readonly teamIds: readonly number[];
  readonly reason?: string;
};

type PlacementFrequency = {
  /** Runs where membership is certain. Without an upper bound, this is exact. */
  count: number;
  probability: number;
  /** Also includes runs where the placement depends on an unresolved tie. */
  upperBound?: { count: number; probability: number };
};

type PositionRangeCount = { from: number; to: number; count: number };

export type LeagueTeamForecast = {
  teamId: number;
  expectedPoints: number;
  pointsInterval80: { lower: number; upper: number };
  /** A resolved joint finish counts at the first position of its shared range. */
  positionDistribution: (PlacementFrequency & { position: number })[];
  /** Subset of positionDistribution covering joint finishes, keyed by exact range. */
  sharedPositionDistribution: {
    from: number;
    to: number;
    count: number;
    probability: number;
  }[];
  /** One entry per configured range, including separate entries with the same zone. */
  zones: (PlacementFrequency & {
    from: number;
    to: number;
    zone: Zone;
    label: string;
  })[];
};

export type LeagueForecastSummary = {
  algorithm:
    | 'complete-league-empirical-summary-v2'
    | typeof LEAGUE_FORECAST_ACCUMULATION_ALGORITHM;
  pointsIntervalMethod: typeof LEAGUE_POINTS_INTERVAL_METHOD;
  competitionCode: SiteCompetitionCode;
  season: number;
  runs: number;
  qualificationNote: string | null;
  /** Number of runs containing at least one unresolved Premier League tie. */
  unresolvedRankingRuns?: number;
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

function placementFrequency(
  positions: readonly number[],
  unresolvedRanges: Iterable<PositionRangeCount>,
  from: number,
  to: number,
  runs: number,
): PlacementFrequency {
  let count = 0;
  for (let position = from; position <= to; position += 1)
    count += positions[position - 1]!;

  let possibleAdditional = 0;
  for (const range of unresolvedRanges) {
    if (from <= range.from && range.to <= to) {
      count += range.count;
    } else if (from <= range.to && range.from <= to) {
      possibleAdditional += range.count;
    }
  }
  if (possibleAdditional === 0) return { count, probability: count / runs };
  const upperCount = count + possibleAdditional;
  return {
    count,
    probability: count / runs,
    upperBound: { count: upperCount, probability: upperCount / runs },
  };
}

/**
 * Accumulate a fixed number of complete league scenarios, without sampling them.
 * Support configured site round-robin leagues and the Champions League league
 * phase. Return null for unsupported formats/seasons. Validate a fixed positive
 * safe-integer roster and run count.
 * Each run must contain every club once, safe integer points (including deductions),
 * and disjoint ranges that cover the entire table. For equal-point Premier League
 * groups, accept shared finishes outside decisive boundaries and unresolved
 * play-off or league-decision ranges crossing a boundary. The caller reconciles
 * season stats and confirms the ranking reason with the competition ranker.
 * Count a shared finish at the first position for every member. For an unresolved
 * range, count certain and possible membership in each event separately. Each run
 * contributes once per event, including zones that overlap multiple possible places.
 * Validate a run before updating any statistics. An invalid run marks the
 * accumulator failed, keeps its completed count and withholds the summary.
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
  if (
    config === undefined ||
    (config.format !== 'round-robin' &&
      !(competitionCode === 'CL' && config.format === 'league-phase'))
  )
    return null;
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
    sharedPositions: new Map<string, PositionRangeCount>(),
    unresolvedPositions: new Map<string, PositionRangeCount>(),
  }));
  let completed = 0;
  let unresolvedRankingRuns = 0;
  let failed = false;

  function prepareRun(
    points: readonly LeagueForecastPoints[],
    groups: readonly LeagueForecastPositionGroup[],
  ) {
    const rows = Array.from(points);
    if (rows.length !== teamCount)
      throw new RangeError('each run requires the complete roster');
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
    const placements = new Map<
      number,
      { from: number; to: number; unresolved: boolean }
    >();
    const occupiedSlots = new Set<number>();
    for (const group of groups) {
      if (
        group == null ||
        !Number.isSafeInteger(group.from) ||
        !Number.isSafeInteger(group.to) ||
        group.from < 1 ||
        group.to > teamCount ||
        group.to < group.from ||
        group.teamIds.length !== group.to - group.from + 1
      ) {
        throw new RangeError(
          'run ranking requires valid ranges and matching club counts',
        );
      }
      const shared = group.reason === 'shared-position';
      const needsPlayOff = group.reason === 'play-off-required';
      const needsDecision = group.reason === 'league-decision-required';
      const unresolved = needsPlayOff || needsDecision;
      if (group.from < group.to || shared || unresolved) {
        const decisive =
          group.from === 1 ||
          zones.some(
            (zone) =>
              (group.from < zone.from && zone.from <= group.to) ||
              (group.from <= zone.to && zone.to < group.to),
          );
        const matchesReason = decisive
          ? group.teamIds.length === 2
            ? needsPlayOff
            : needsDecision
          : shared;
        if (
          group.from === group.to ||
          competitionCode !== 'PL' ||
          !matchesReason ||
          group.teamIds.some(
            (id) => pointMap.get(id) !== pointMap.get(group.teamIds[0]!),
          )
        )
          throw new RangeError('invalid Premier League ranking range');
      }
      const placement = { from: group.from, to: group.to, unresolved };
      for (let slot = group.from; slot <= group.to; slot += 1) {
        if (occupiedSlots.has(slot))
          throw new RangeError(
            'a ranking slot cannot belong to more than one group',
          );
        occupiedSlots.add(slot);
      }
      for (const teamId of group.teamIds) {
        if (!roster.has(teamId) || placements.has(teamId))
          throw new RangeError('each club must appear once in the ranking');
        placements.set(teamId, placement);
      }
    }
    if (placements.size !== teamCount)
      throw new RangeError('run ranking must cover the complete league');
    return ids.map((teamId) => ({
      points: pointMap.get(teamId)!,
      ...placements.get(teamId)!,
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
        if (!row.unresolved) state.positions[row.from - 1]! += 1;
        if (row.from < row.to) {
          const ranges = row.unresolved
            ? state.unresolvedPositions
            : state.sharedPositions;
          const key = row.from + ':' + row.to;
          const range = ranges.get(key);
          if (range === undefined) {
            ranges.set(key, { from: row.from, to: row.to, count: 1 });
          } else {
            range.count += 1;
          }
        }
      });
      if (prepared.some(({ unresolved }) => unresolved)) unresolvedRankingRuns += 1;
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
        ...(unresolvedRankingRuns > 0 && { unresolvedRankingRuns }),
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
            positionDistribution: state.positions.map((_, index) => ({
              position: index + 1,
              ...placementFrequency(
                state.positions,
                state.unresolvedPositions.values(),
                index + 1,
                index + 1,
                completed,
              ),
            })),
            sharedPositionDistribution: [...state.sharedPositions.values()]
              .sort((left, right) => left.from - right.from || left.to - right.to)
              .map((range) => ({ ...range, probability: range.count / completed })),
            zones: zones.map((zone) => ({
              ...zone,
              ...placementFrequency(
                state.positions,
                state.unresolvedPositions.values(),
                zone.from,
                zone.to,
                completed,
              ),
            })),
          };
        }),
      };
    },
  };
}
