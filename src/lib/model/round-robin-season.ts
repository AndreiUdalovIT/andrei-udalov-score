import type { CompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import type { SeasonFixtureScore } from './season-calendar-sampler';
import {
  projectSeasonStats,
  type ProjectedSeasonStats,
  type SeasonStatsBaseline,
} from './season-stats';

export type RoundRobinMatchScore = Omit<SeasonFixtureScore, 'source'>;

/** Reconcile final statistics with a complete standard double round-robin. */
export function reconcileRoundRobinSeason(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  format: Readonly<Pick<CompetitionSeasonConfig, 'teamCount' | 'matchdays'>>,
): ProjectedSeasonStats[] | null {
  const { teamCount, matchdays } = format;
  const matchCount = (teamCount * matchdays) / 2;
  if (
    !Number.isSafeInteger(teamCount) ||
    teamCount <= 0 ||
    !Number.isSafeInteger(matchdays) ||
    matchdays !== 2 * (teamCount - 1) ||
    !Number.isSafeInteger(matchCount)
  ) {
    throw new RangeError(
      'format must describe a finite standard double round-robin',
    );
  }
  const stats = projectSeasonStats(
    rows,
    scores.map((score) => ({ ...score, source: 'known-result' as const })),
  );
  if (stats === null || stats.length !== teamCount || scores.length !== matchCount) {
    return null;
  }
  const pairs = new Set<string>();
  for (const score of scores) {
    const pair = `${score.homeTeamId}:${score.awayTeamId}`;
    if (pairs.has(pair)) return null;
    pairs.add(pair);
  }
  return stats;
}
