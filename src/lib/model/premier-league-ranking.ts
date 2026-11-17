import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  reconcileRoundRobinSeason,
  type RoundRobinMatchScore,
} from './round-robin-season';
import { groupSeasonRankings } from './season-ranking-groups';
import type { SeasonStatsBaseline } from './season-stats';

export const PREMIER_LEAGUE_RANKING_ALGORITHM = 'pl-table-head-to-head-v1';

export type PremierLeagueMatchScore = RoundRobinMatchScore;

export type PremierLeaguePositionGroup = {
  from: number;
  to: number;
  teamIds: number[];
  reason:
    | 'table-criteria'
    | 'head-to-head'
    | 'shared-position'
    | 'play-off-required'
    | 'league-decision-required';
};

export type PremierLeagueSeasonRanking = {
  algorithm: typeof PREMIER_LEAGUE_RANKING_ALGORITHM;
  season: number;
  /** Champion and configured qualification/relegation transitions. */
  decisiveBoundaries: number[];
  qualificationNote: string | null;
  groups: PremierLeaguePositionGroup[];
};

function crossesBoundary(
  from: number,
  to: number,
  boundaries: readonly number[],
): boolean {
  return boundaries.some((boundary) => from <= boundary && boundary < to);
}

/**
 * Rank one complete standard Premier League season under C.4-C.7 and C.17.
 * https://www.premierleague.com/en/media/publications
 * All match scores describe their known or simulated 90-minute outcomes.
 * Reconcile them with the supplied final stats and require one match in each
 * direction for every pair of the configured twenty clubs.
 * C.17 uses boundaries from the season's configured zones plus the title.
 * Both head-to-head criteria use matches within the original tied group.
 * Remaining two-club decisive ties require a neutral play-off. Larger decisive
 * ties are reported for a League decision about the further resolution.
 * Return null for unconfigured seasons, mismatched totals or incomplete pair
 * coverage. Invalid values, unknown participants and unsafe arithmetic throw
 * RangeError via the stats projector.
 */
export function rankPremierLeagueSeason(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<PremierLeagueMatchScore>[],
  season: number,
): PremierLeagueSeasonRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const config = getCompetitionSeasonConfig('PL', season);
  if (config === undefined) return null;

  const stats = reconcileRoundRobinSeason(rows, scores, config);
  if (stats === null) return null;

  const decisiveBoundaries = [
    ...new Set([1, ...config.zones.flatMap(({ from, to }) => [from - 1, to])]),
  ]
    .filter((boundary) => boundary > 0 && boundary < config.teamCount)
    .sort((left, right) => left - right);
  const tableGroups = groupSeasonRankings(
    stats.map((row) => ({
      teamId: row.teamId,
      criteria: [row.points, row.goalDifference, row.goalsFor],
    })),
  );
  const groups: PremierLeaguePositionGroup[] = [];

  for (const group of tableGroups) {
    if (
      group.teamIds.length === 1 ||
      !crossesBoundary(group.from, group.to, decisiveBoundaries)
    ) {
      groups.push({
        from: group.from,
        to: group.to,
        teamIds: group.teamIds,
        reason: group.teamIds.length === 1 ? 'table-criteria' : 'shared-position',
      });
      continue;
    }

    const headToHeadStats = new Map(
      group.teamIds.map((teamId) => [teamId, { points: 0, awayGoals: 0 }]),
    );
    for (const score of scores) {
      const home = headToHeadStats.get(score.homeTeamId);
      const away = headToHeadStats.get(score.awayTeamId);
      if (home === undefined || away === undefined) continue;
      away.awayGoals += score.awayGoals90;
      if (score.homeGoals90 > score.awayGoals90) {
        home.points += 3;
      } else if (score.homeGoals90 < score.awayGoals90) {
        away.points += 3;
      } else {
        home.points += 1;
        away.points += 1;
      }
    }
    const headGroups = groupSeasonRankings(
      [...headToHeadStats].map(([teamId, row]) => ({
        teamId,
        criteria: [row.points, row.awayGoals],
      })),
    );
    for (const headGroup of headGroups) {
      const from = group.from + headGroup.from - 1;
      const to = group.from + headGroup.to - 1;
      let reason: PremierLeaguePositionGroup['reason'] = 'head-to-head';
      if (headGroup.teamIds.length > 1) {
        reason = 'shared-position';
        if (crossesBoundary(from, to, decisiveBoundaries)) {
          reason =
            headGroup.teamIds.length === 2
              ? 'play-off-required'
              : 'league-decision-required';
        }
      }
      groups.push({ from, to, teamIds: headGroup.teamIds, reason });
    }
  }

  return {
    algorithm: PREMIER_LEAGUE_RANKING_ALGORITHM,
    season,
    decisiveBoundaries,
    qualificationNote: config.qualificationNote,
    groups,
  };
}
