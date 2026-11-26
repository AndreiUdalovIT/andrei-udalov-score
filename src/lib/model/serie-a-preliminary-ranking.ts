import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import { calculateVenueStats } from '@/lib/football/venue-stats';

import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { groupSeasonRankings } from './season-ranking-groups';
import type { SeasonStatsBaseline } from './season-stats';

export const SERIE_A_PRELIMINARY_RANKING_ALGORITHM = 'sa-points-group-avulsa-v1';

const supportedSeasons: readonly number[] = [2023, 2024, 2025, 2026];

export type SerieAPreliminaryPositionGroup = {
  from: number;
  to: number;
  teamIds: number[];
  /** Official adjusted points shared by this group. */
  points: number;
  reason: 'points' | 'classifica-avulsa' | 'drawing-of-lots-required';
};

export type SerieAPreliminaryRanking = {
  algorithm: typeof SERIE_A_PRELIMINARY_RANKING_ALGORITHM;
  season: number;
  scope: 'before-play-offs';
  qualificationNote: string | null;
  groups: SerieAPreliminaryPositionGroup[];
};

/**
 * Build a preliminary Serie A classification before title/relegation play-offs.
 * FIGC seasonal derogations to NOIF 51, e.g. CU 331/A (2025/26), point 3:
 * https://www.figc.it/media/274515/331-deroga-art-51-noif-determinazione-classifica-campionato-serie-a-ss-2025-2026.pdf
 * Within each group tied on official points, compare head-to-head points and
 * goal difference among ALL original members, then overall goal difference
 * and overall goals scored. Do not restart the mini-table for smaller subgroups.
 * Equal criteria retain a range requiring an official draw of lots.
 * These positions do not determine a tied title or relegation without the
 * separate seasonal play-off rules, including the 2026/27 UEFA-finalist exception.
 * Return null for unconfigured seasons, inconsistent totals or incomplete pairs.
 * Invalid inputs and unsafe arithmetic throw RangeError.
 */
export function rankSerieAPreliminaryTable(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
): SerieAPreliminaryRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const config = getCompetitionSeasonConfig('SA', season);
  if (config === undefined || !supportedSeasons.includes(season)) return null;
  const stats = reconcileRoundRobinSeason(rows, scores, config);
  if (stats === null) return null;

  const totals = new Map(stats.map((row) => [row.teamId, row]));
  const matches = scores.map((score) => ({ ...score, status: 'FINISHED' as const }));
  const pointsGroups = groupSeasonRankings(
    stats.map((row) => ({
      teamId: row.teamId,
      criteria: [row.points],
    })),
  );
  const groups: SerieAPreliminaryPositionGroup[] = [];

  for (const pointsGroup of pointsGroups) {
    const points = totals.get(pointsGroup.teamIds[0]!)!.points;
    if (pointsGroup.teamIds.length === 1) {
      groups.push({
        from: pointsGroup.from,
        to: pointsGroup.to,
        teamIds: pointsGroup.teamIds,
        points,
        reason: 'points',
      });
      continue;
    }
    const home = calculateVenueStats(pointsGroup.teamIds, matches, 'home');
    const away = calculateVenueStats(pointsGroup.teamIds, matches, 'away');
    const miniGroups = groupSeasonRankings(
      home.map((row, index) => {
        const visiting = away[index]!;
        const total = totals.get(row.teamId)!;
        return {
          teamId: row.teamId,
          criteria: [
            row.points + visiting.points,
            row.goalDifference + visiting.goalDifference,
            total.goalDifference,
            total.goalsFor,
          ],
        };
      }),
    );
    for (const miniGroup of miniGroups) {
      groups.push({
        from: pointsGroup.from + miniGroup.from - 1,
        to: pointsGroup.from + miniGroup.to - 1,
        teamIds: miniGroup.teamIds,
        points,
        reason:
          miniGroup.teamIds.length === 1
            ? 'classifica-avulsa'
            : 'drawing-of-lots-required',
      });
    }
  }

  return {
    algorithm: SERIE_A_PRELIMINARY_RANKING_ALGORITHM,
    season,
    scope: 'before-play-offs',
    qualificationNote: config.qualificationNote,
    groups,
  };
}
