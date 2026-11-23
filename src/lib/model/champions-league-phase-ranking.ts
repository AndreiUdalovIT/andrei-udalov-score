import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import type { SeasonFixtureScore } from './season-calendar-sampler';
import {
  groupSeasonRankings,
  type SeasonRankingGroup,
} from './season-ranking-groups';
import {
  projectSeasonStats,
  type SeasonStatsBaseline,
  type ProjectedSeasonStats,
} from './season-stats';

export const CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM =
  'ucl-league-phase-article-18-v1';

const criterionOrder = [
  'points',
  'goalDifference',
  'goalsFor',
  'awayGoals',
  'won',
  'awayWins',
  'opponentPoints',
  'opponentGoalDifference',
  'opponentGoalsFor',
  'disciplinaryPoints',
  'clubCoefficient',
] as const;

type RankingCriterion = (typeof criterionOrder)[number];

export type ChampionsLeaguePhaseTieBreakContext = {
  readonly teamId: number;
  /** Final phase total for players and team officials, or null if unknown. */
  readonly disciplinaryPoints: number | null;
  /** Applicable UEFA sporting club coefficient, or null if unknown. */
  readonly clubCoefficient: number | null;
};

export type ChampionsLeaguePhaseRow = ProjectedSeasonStats & {
  awayGoals: number;
  awayWins: number;
  opponentPoints: number;
  opponentGoalDifference: number;
  opponentGoalsFor: number;
  disciplinaryPoints: number | null;
  clubCoefficient: number | null;
};

export type ChampionsLeaguePhaseRanking = {
  algorithm: typeof CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM;
  season: number;
  scope: 'final-league-phase';
  /** Canonical team ID order. Use groups for positions. */
  rows: ChampionsLeaguePhaseRow[];
  groups: (Omit<SeasonRankingGroup, 'missingCriterion'> & {
    missingCriterion: RankingCriterion | null;
  })[];
};

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError('collective opponent totals exceed the safe integer range');
  return result;
}

/**
 * Classify a complete standard UEFA Champions League league phase under
 * Articles 17–18 (2024/25 through 2026/27). Scores describe regulation time.
 * Reconcile them against the supplied table. Require eight distinct opponents
 * and four home/four away games per club. The caller scopes the calendar to
 * the official draw or an explicit scenario.
 *
 * Calculate collective opponent totals from each opponent's whole phase,
 * including its game against the club being ranked. Apply the final criteria
 * in order, treating lower disciplinary totals as better. Callers provide those
 * totals and the applicable sporting coefficient. If comparing tied clubs needs
 * missing data, keep their range and identify the first missing criterion.
 * A tie after all criteria stays unresolved. Do not seed by team ID or use
 * the ordering from a different table such as the coefficient ranking.
 *
 * Return null for unsupported seasons, incomplete or inconsistent phases and
 * exceptional points adjustments. Invalid scores, context and unsafe totals
 * throw RangeError. This function neither draws opponents nor resolves
 * cancelled matches or administrative changes to the format.
 */
export function rankChampionsLeaguePhase(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<Omit<SeasonFixtureScore, 'source'>>[],
  season: number,
  context: readonly ChampionsLeaguePhaseTieBreakContext[] = [],
): ChampionsLeaguePhaseRanking | null {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const format = getCompetitionSeasonConfig('CL', season);
  if (format?.format !== 'league-phase') return null;

  const stats = projectSeasonStats(
    rows,
    scores.map((score) => ({ ...score, source: 'known-result' })),
  );
  if (
    stats === null ||
    stats.length !== format.teamCount ||
    scores.length !== (format.teamCount * format.matchdays) / 2 ||
    stats.some(
      (row) => row.playedGames !== format.matchdays || row.pointsAdjustment !== 0,
    )
  )
    return null;

  const clubs = new Map(
    stats.map((row) => [
      row.teamId,
      {
        row,
        opponents: new Set<number>(),
        homeGames: 0,
        awayGoals: 0,
        awayWins: 0,
      },
    ]),
  );
  const tieBreaks = new Map<number, ChampionsLeaguePhaseTieBreakContext>();
  for (const entry of context) {
    if (
      entry == null ||
      !clubs.has(entry.teamId) ||
      tieBreaks.has(entry.teamId) ||
      (entry.disciplinaryPoints !== null &&
        (!Number.isSafeInteger(entry.disciplinaryPoints) ||
          entry.disciplinaryPoints < 0)) ||
      (entry.clubCoefficient !== null &&
        (!Number.isFinite(entry.clubCoefficient) || entry.clubCoefficient < 0))
    )
      throw new RangeError(
        'tie-break context requires unique clubs and valid totals or null',
      );
    tieBreaks.set(entry.teamId, entry);
  }

  for (const score of scores) {
    const home = clubs.get(score.homeTeamId)!;
    const away = clubs.get(score.awayTeamId)!;
    if (home.opponents.has(score.awayTeamId)) return null;
    home.opponents.add(score.awayTeamId);
    away.opponents.add(score.homeTeamId);
    home.homeGames += 1;
    away.awayGoals += score.awayGoals90;
    if (score.awayGoals90 > score.homeGoals90) away.awayWins += 1;
  }
  const clubsInIdOrder = [...clubs.values()];
  if (clubsInIdOrder.some((club) => club.homeGames !== format.matchdays / 2))
    return null;

  const finalRows = clubsInIdOrder.map((club): ChampionsLeaguePhaseRow => {
    let opponentPoints = 0;
    let opponentGoalDifference = BigInt(0);
    let opponentGoalsFor = BigInt(0);
    for (const id of club.opponents) {
      const opponent = clubs.get(id)!.row;
      opponentPoints += opponent.points;
      opponentGoalDifference += BigInt(opponent.goalDifference);
      opponentGoalsFor += BigInt(opponent.goalsFor);
    }
    const supplied = tieBreaks.get(club.row.teamId);
    return {
      ...club.row,
      awayGoals: club.awayGoals,
      awayWins: club.awayWins,
      opponentPoints,
      opponentGoalDifference: safeNumber(opponentGoalDifference),
      opponentGoalsFor: safeNumber(opponentGoalsFor),
      disciplinaryPoints: supplied?.disciplinaryPoints ?? null,
      clubCoefficient: supplied?.clubCoefficient ?? null,
    };
  });

  const groups = groupSeasonRankings(
    finalRows.map((row) => ({
      teamId: row.teamId,
      criteria: criterionOrder.map((key) => {
        const value = row[key];
        return key === 'disciplinaryPoints' && value !== null ? -value : value;
      }),
    })),
  );
  return {
    algorithm: CHAMPIONS_LEAGUE_PHASE_RANKING_ALGORITHM,
    season,
    scope: 'final-league-phase',
    rows: finalRows,
    groups: groups.map(({ missingCriterion, ...group }) => ({
      ...group,
      missingCriterion:
        missingCriterion === null ? null : criterionOrder[missingCriterion]!,
    })),
  };
}
