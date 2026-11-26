import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import { calculateVenueStats } from '@/lib/football/venue-stats';

import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { groupSeasonRankings } from './season-ranking-groups';
import type { SeasonStatsBaseline } from './season-stats';

export const LA_LIGA_RANKING_ALGORITHM = 'pd-recursive-head-to-head-v1';

/** Comparable final Fair Play ranks; lower is better and equal ranks stay tied. */
export type LaLigaFairPlayRank = {
  teamId: number;
  /** Null or an omitted club means that its final ranking is unavailable. */
  rank: number | null;
};

type RankingCriterion =
  | 'points'
  | 'head-to-head-points'
  | 'head-to-head-goal-difference'
  | 'overall-goal-difference'
  | 'overall-goals-scored'
  | 'fair-play';

export type LaLigaPositionGroup = {
  from: number;
  to: number;
  teamIds: number[];
  reason:
    | RankingCriterion
    | 'fair-play-data-required'
    | 'play-off-required'
    | 'federation-decision-required';
};

export type LaLigaSeasonRanking = {
  algorithm: typeof LA_LIGA_RANKING_ALGORITHM;
  season: number;
  qualificationNote: string | null;
  groups: LaLigaPositionGroup[];
};

/**
 * Rank a complete standard La Liga season under RFEF Competition Regulations 29
 * (formerly General Regulations 224) and the season's Primera Division bases.
 * https://rfef.es/es/federacion/normativas-y-circulares/reglamentos
 * Two tied clubs start with head-to-head goal difference; larger groups first
 * compare head-to-head points. Overall goal difference, goals and Fair Play follow.
 * After any split, restart the appropriate rules within each smaller tied group.
 * Fair Play ranks must describe the final scenario, including equal ranks.
 * Do not substitute current rankings for unavailable future disciplinary outcomes.
 * Missing Fair Play keeps a range. Complete equality needs a neutral play-off
 * for two clubs, or a Federation decision on further matches for larger groups.
 * Return null for unconfigured seasons, inconsistent totals or incomplete pairs.
 * Invalid inputs and unsafe arithmetic throw RangeError.
 */
export function rankLaLigaSeason(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
  fairPlay: readonly Readonly<LaLigaFairPlayRank>[] = [],
): LaLigaSeasonRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const config = getCompetitionSeasonConfig('PD', season);
  if (config === undefined) return null;
  const stats = reconcileRoundRobinSeason(rows, scores, config);
  if (stats === null) return null;

  const totals = new Map(stats.map((row) => [row.teamId, row]));
  const fairRanks = new Map<number, number | null>();
  for (const row of fairPlay) {
    if (!totals.has(row.teamId) || fairRanks.has(row.teamId)) {
      throw new RangeError('Fair Play requires unique IDs from the season roster');
    }
    if (row.rank !== null && (!Number.isSafeInteger(row.rank) || row.rank <= 0)) {
      throw new RangeError('Fair Play ranks must be positive safe integers or null');
    }
    fairRanks.set(row.teamId, row.rank);
  }
  const matches = scores.map((score) => ({ ...score, status: 'FINISHED' as const }));

  function refine(
    teamIds: number[],
    from: number,
    resolvedBy: RankingCriterion,
  ): LaLigaPositionGroup[] {
    if (teamIds.length === 1) {
      return [{ from, to: from, teamIds, reason: resolvedBy }];
    }
    const home = calculateVenueStats(teamIds, matches, 'home');
    const away = calculateVenueStats(teamIds, matches, 'away');
    const head = new Map(
      home.map((row, index) => [
        row.teamId,
        {
          points: row.points + away[index]!.points,
          goalDifference: row.goalDifference + away[index]!.goalDifference,
        },
      ]),
    );
    const criteria: {
      reason: RankingCriterion;
      value: (teamId: number) => number | null;
    }[] = [];
    if (teamIds.length > 2) {
      criteria.push({
        reason: 'head-to-head-points',
        value: (teamId) => head.get(teamId)!.points,
      });
    }
    criteria.push(
      {
        reason: 'head-to-head-goal-difference',
        value: (teamId) => head.get(teamId)!.goalDifference,
      },
      {
        reason: 'overall-goal-difference',
        value: (teamId) => totals.get(teamId)!.goalDifference,
      },
      {
        reason: 'overall-goals-scored',
        value: (teamId) => totals.get(teamId)!.goalsFor,
      },
      {
        reason: 'fair-play',
        value: (teamId) => {
          const rank = fairRanks.get(teamId);
          return rank === undefined || rank === null ? null : -rank;
        },
      },
    );
    for (const criterion of criteria) {
      const groups = groupSeasonRankings(
        teamIds.map((teamId) => ({
          teamId,
          criteria: [criterion.value(teamId)],
        })),
      );
      if (groups.length > 1) {
        return groups.flatMap((group) =>
          refine(group.teamIds, from + group.from - 1, criterion.reason),
        );
      }
      if (groups[0]!.missingCriterion !== null) {
        return [
          {
            from,
            to: from + teamIds.length - 1,
            teamIds,
            reason: 'fair-play-data-required',
          },
        ];
      }
    }
    return [
      {
        from,
        to: from + teamIds.length - 1,
        teamIds,
        reason:
          teamIds.length === 2
            ? 'play-off-required'
            : 'federation-decision-required',
      },
    ];
  }

  const groups = groupSeasonRankings(
    stats.map((row) => ({
      teamId: row.teamId,
      criteria: [row.points],
    })),
  ).flatMap((group) => refine(group.teamIds, group.from, 'points'));

  return {
    algorithm: LA_LIGA_RANKING_ALGORITHM,
    season,
    qualificationNote: config.qualificationNote,
    groups,
  };
}
