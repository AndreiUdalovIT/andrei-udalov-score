import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import { calculateVenueStats } from '@/lib/football/venue-stats';

import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { groupSeasonRankings } from './season-ranking-groups';
import type { SeasonStatsBaseline } from './season-stats';

export const LIGUE1_RANKING_ALGORITHM = 'fl1-season-head-to-head-v1';

export type Ligue1Ruleset = 'lfp-518-ter-2023-2025' | 'lfp-518-ter-2025-2027';

const rulesBySeason: Readonly<Record<number, Ligue1Ruleset>> = {
  2023: 'lfp-518-ter-2023-2025',
  2024: 'lfp-518-ter-2023-2025',
  2025: 'lfp-518-ter-2025-2027',
  2026: 'lfp-518-ter-2025-2027',
};

/** Final player disciplinary totals under the season's LFP 1/3-point scale. */
export type Ligue1DisciplinaryPoints = {
  teamId: number;
  /** Null or an omitted club means that its final total is unavailable. */
  points: number | null;
};

export type Ligue1PositionGroup = {
  from: number;
  to: number;
  teamIds: number[];
  reason:
    | 'table-criteria'
    | 'head-to-head'
    | 'season-criteria'
    | 'disciplinary-data-required'
    | 'drawing-of-lots-required'
    | 'league-decision-required';
};

export type Ligue1SeasonRanking = {
  algorithm: typeof LIGUE1_RANKING_ALGORITHM;
  season: number;
  ruleset: Ligue1Ruleset;
  qualificationNote: string | null;
  groups: Ligue1PositionGroup[];
};

/**
 * Rank a complete standard Ligue 1 season under LFP article 518 ter.
 * https://www.lfp.fr/assets/26_27_Reglement_Competitions_08_09_2026_45d0881157.pdf
 * https://www.lfp.fr/assets/24_25_LFP_STATUTS_REGLEMENTS_05_08_2024_d62f361d1f.pdf
 * First compare points and overall goal difference. Calculate all head-to-head
 * criteria within the original group still tied on both of these table criteria.
 * Legacy seasons also compare head-to-head goals and away goals, then overall
 * goals and away goals. Modern seasons use overall goals, wins and away wins
 * after head-to-head points and goal difference.
 * Final disciplinary totals are supplied separately, with lower totals better.
 * Missing future discipline keeps a range; current totals are not final forecasts.
 * Complete modern ties need a draw of lots; legacy ties need an LFP decision.
 * This function records the unresolved range without performing either action.
 * Return null for unconfigured seasons, inconsistent totals or incomplete pairs.
 * Invalid inputs and unsafe arithmetic throw RangeError.
 */
export function rankLigue1Season(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
  discipline: readonly Readonly<Ligue1DisciplinaryPoints>[] = [],
): Ligue1SeasonRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const config = getCompetitionSeasonConfig('FL1', season);
  const ruleset = rulesBySeason[season];
  if (config === undefined || ruleset === undefined) return null;
  const stats = reconcileRoundRobinSeason(rows, scores, config);
  if (stats === null) return null;

  const modern = ruleset === 'lfp-518-ter-2025-2027';
  const totals = new Map(stats.map((row) => [row.teamId, row]));
  const disciplinaryPoints = new Map<number, number | null>();
  for (const row of discipline) {
    if (!totals.has(row.teamId) || disciplinaryPoints.has(row.teamId)) {
      throw new RangeError('discipline requires unique IDs from the season roster');
    }
    if (
      row.points !== null &&
      (!Number.isSafeInteger(row.points) || row.points < 0)
    ) {
      throw new RangeError(
        'disciplinary points must be non-negative safe integers or null',
      );
    }
    disciplinaryPoints.set(row.teamId, row.points);
  }
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
      criteria: [row.points, row.goalDifference],
    })),
  );
  const groups: Ligue1PositionGroup[] = [];

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
    const home = calculateVenueStats(group.teamIds, matches, 'home');
    const away = calculateVenueStats(group.teamIds, matches, 'away');
    const headGroups = groupSeasonRankings(
      home.map((row, index) => {
        const visiting = away[index]!;
        const criteria = [
          row.points + visiting.points,
          row.goalDifference + visiting.goalDifference,
        ];
        if (!modern)
          criteria.push(row.goalsFor + visiting.goalsFor, visiting.goalsFor);
        return { teamId: row.teamId, criteria };
      }),
    );
    for (const headGroup of headGroups) {
      const from = group.from + headGroup.from - 1;
      if (headGroup.teamIds.length === 1) {
        groups.push({
          from,
          to: from,
          teamIds: headGroup.teamIds,
          reason: 'head-to-head',
        });
        continue;
      }
      const seasonGroups = groupSeasonRankings(
        headGroup.teamIds.map((teamId) => {
          const row = totals.get(teamId)!;
          const visiting = allAway.get(teamId)!;
          const points = disciplinaryPoints.get(teamId);
          const criteria: (number | null)[] = modern
            ? [row.goalsFor, row.won, visiting.won]
            : [row.goalsFor, visiting.goalsFor];
          criteria.push(points === undefined || points === null ? null : -points);
          return { teamId, criteria };
        }),
      );
      for (const seasonGroup of seasonGroups) {
        let reason: Ligue1PositionGroup['reason'] = 'season-criteria';
        if (seasonGroup.teamIds.length > 1) {
          reason =
            seasonGroup.reason === 'missing-criterion'
              ? 'disciplinary-data-required'
              : modern
                ? 'drawing-of-lots-required'
                : 'league-decision-required';
        }
        groups.push({
          from: from + seasonGroup.from - 1,
          to: from + seasonGroup.to - 1,
          teamIds: seasonGroup.teamIds,
          reason,
        });
      }
    }
  }

  return {
    algorithm: LIGUE1_RANKING_ALGORITHM,
    season,
    ruleset,
    qualificationNote: config.qualificationNote,
    groups,
  };
}
