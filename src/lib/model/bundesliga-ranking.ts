import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import { calculateVenueStats } from '@/lib/football/venue-stats';

import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { groupSeasonRankings } from './season-ranking-groups';
import type { SeasonStatsBaseline } from './season-stats';

export const BUNDESLIGA_RANKING_ALGORITHM = 'bl1-two-club-head-to-head-v1';

export type BundesligaPositionGroup = {
  from: number;
  to: number;
  teamIds: number[];
  reason:
    | 'table-criteria'
    | 'head-to-head'
    | 'all-away-goals'
    | 'play-off-required'
    | 'rule-interpretation-required';
};

export type BundesligaSeasonRanking = {
  algorithm: typeof BUNDESLIGA_RANKING_ALGORITHM;
  season: number;
  qualificationNote: string | null;
  groups: BundesligaPositionGroup[];
};

/**
 * Rank a complete standard Bundesliga season using DFL SpOL section 2(3)(c).
 * https://media.dfl.de/sites/2/2026/03/Spielordnung-SpOL-2026-03-06-Stand.pdf
 * Apply points, overall goal difference and overall goals scored first.
 * For two tied clubs use aggregate head-to-head goal difference, head-to-head
 * away goals and then all away goals. A remaining tie requires a neutral play-off.
 * Three or more clubs tied on the table criteria retain their range and receive
 * rule-interpretation-required, pending an explicit multi-club comparison rule.
 * Return null for unconfigured seasons, inconsistent totals or incomplete pairs.
 */
export function rankBundesligaSeason(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
): BundesligaSeasonRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const config = getCompetitionSeasonConfig('BL1', season);
  if (config === undefined) return null;
  const stats = reconcileRoundRobinSeason(rows, scores, config);
  if (stats === null) return null;

  const matches = scores.map((score) => ({ ...score, status: 'FINISHED' as const }));
  const allAway = new Map(
    calculateVenueStats(
      stats.map(({ teamId }) => teamId),
      matches,
      'away',
    ).map((row) => [row.teamId, row]),
  );
  const tableGroups = groupSeasonRankings(
    stats.map((row) => ({
      teamId: row.teamId,
      criteria: [row.points, row.goalDifference, row.goalsFor],
    })),
  );
  const groups: BundesligaPositionGroup[] = [];
  for (const group of tableGroups) {
    if (group.teamIds.length === 1) {
      groups.push({
        from: group.from,
        to: group.to,
        teamIds: group.teamIds,
        reason: 'table-criteria',
      });
      continue;
    }
    if (group.teamIds.length > 2) {
      groups.push({
        from: group.from,
        to: group.to,
        teamIds: group.teamIds,
        reason: 'rule-interpretation-required',
      });
      continue;
    }
    const home = calculateVenueStats(group.teamIds, matches, 'home');
    const away = calculateVenueStats(group.teamIds, matches, 'away');
    const comparisons = home.map((row, index) => ({
      teamId: row.teamId,
      criteria: [
        row.goalDifference + away[index]!.goalDifference,
        away[index]!.goalsFor,
        allAway.get(row.teamId)!.goalsFor,
      ],
    }));
    const needsAllAway =
      comparisons[0]!.criteria[0] === comparisons[1]!.criteria[0] &&
      comparisons[0]!.criteria[1] === comparisons[1]!.criteria[1];
    for (const compared of groupSeasonRankings(comparisons)) {
      let reason: BundesligaPositionGroup['reason'] = 'head-to-head';
      if (needsAllAway) reason = 'all-away-goals';
      if (compared.teamIds.length > 1) reason = 'play-off-required';
      groups.push({
        from: group.from + compared.from - 1,
        to: group.from + compared.to - 1,
        teamIds: compared.teamIds,
        reason,
      });
    }
  }

  return {
    algorithm: BUNDESLIGA_RANKING_ALGORITHM,
    season,
    qualificationNote: config.qualificationNote,
    groups,
  };
}
