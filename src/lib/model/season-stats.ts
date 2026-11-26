import type { VenueStats } from '@/lib/football/venue-stats';

import type { SeasonFixtureScore } from './season-calendar-sampler';

/** One official table, scoped to a season and stage; points may be negative. */
export type SeasonStatsBaseline = Omit<VenueStats, 'goalDifference'>;

export type ProjectedSeasonStats = VenueStats & {
  /** Current official points minus the points earned from current results. */
  pointsAdjustment: number;
};

const countFields = [
  'playedGames',
  'won',
  'draw',
  'lost',
  'goalsFor',
  'goalsAgainst',
] as const;

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError('season statistics exceed the safe integer range');
  }
  return sum;
}

function validateStats(row: Readonly<SeasonStatsBaseline>): number {
  if (
    !Number.isSafeInteger(row.teamId) ||
    row.teamId <= 0 ||
    !Number.isSafeInteger(row.points) ||
    countFields.some((field) => !Number.isSafeInteger(row[field]) || row[field] < 0)
  ) {
    throw new RangeError(
      'table rows require a positive team ID and safe integer statistics',
    );
  }
  if (checkedAdd(checkedAdd(row.won, row.draw), row.lost) !== row.playedGames) {
    throw new RangeError('played games must equal wins, draws and losses');
  }
  const earnedPoints = row.won * 3 + row.draw;
  if (!Number.isSafeInteger(earnedPoints)) {
    throw new RangeError('earned points exceed the safe integer range');
  }
  return checkedAdd(row.points, -earnedPoints);
}

function copyStats(row: Readonly<SeasonStatsBaseline>): SeasonStatsBaseline {
  return {
    teamId: row.teamId,
    playedGames: row.playedGames,
    won: row.won,
    draw: row.draw,
    lost: row.lost,
    points: row.points,
    goalsFor: row.goalsFor,
    goalsAgainst: row.goalsAgainst,
  };
}

function addResult(
  row: SeasonStatsBaseline,
  goalsFor: number,
  goalsAgainst: number,
): void {
  row.playedGames = checkedAdd(row.playedGames, 1);
  row.goalsFor = checkedAdd(row.goalsFor, goalsFor);
  row.goalsAgainst = checkedAdd(row.goalsAgainst, goalsAgainst);
  if (goalsFor > goalsAgainst) {
    row.won = checkedAdd(row.won, 1);
    row.points = checkedAdd(row.points, 3);
  } else if (goalsFor === goalsAgainst) {
    row.draw = checkedAdd(row.draw, 1);
    row.points = checkedAdd(row.points, 1);
  } else {
    row.lost = checkedAdd(row.lost, 1);
  }
}

/**
 * Add only simulated results to an official baseline, preserving its current
 * point adjustments. Known results must reconcile all baseline counts and goals;
 * their earned points need not equal the official points.
 * Return null when known results do not reconcile with the baseline.
 * Throw RangeError for invalid inputs or unsafe arithmetic.
 * The caller supplies one complete, cutoff-consistent season/stage snapshot.
 * Current adjustments stay fixed; future administrative decisions are not modeled.
 * Return fresh rows in team ID order, without positions or tie-breaker ranking.
 */
export function projectSeasonStats(
  baseline: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<SeasonFixtureScore>[],
): ProjectedSeasonStats[] | null {
  const teams = new Map<
    number,
    {
      baseline: SeasonStatsBaseline;
      projected: SeasonStatsBaseline;
      known: SeasonStatsBaseline;
      pointsAdjustment: number;
    }
  >();
  for (const row of [...baseline].sort(
    (left, right) => left.teamId - right.teamId,
  )) {
    const pointsAdjustment = validateStats(row);
    if (teams.has(row.teamId))
      throw new RangeError('baseline team IDs must be unique');
    teams.set(row.teamId, {
      baseline: copyStats(row),
      projected: copyStats(row),
      known: {
        teamId: row.teamId,
        playedGames: 0,
        won: 0,
        draw: 0,
        lost: 0,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 0,
      },
      pointsAdjustment,
    });
  }

  const seen = new Set<number>();
  for (const score of [...scores].sort((left, right) => left.id - right.id)) {
    if (
      [score.id, score.homeTeamId, score.awayTeamId].some(
        (id) => !Number.isSafeInteger(id) || id <= 0,
      ) ||
      score.homeTeamId === score.awayTeamId ||
      seen.has(score.id)
    ) {
      throw new RangeError(
        'scores require unique positive IDs and distinct positive team IDs',
      );
    }
    seen.add(score.id);
    if (
      !Number.isSafeInteger(score.homeGoals90) ||
      score.homeGoals90 < 0 ||
      !Number.isSafeInteger(score.awayGoals90) ||
      score.awayGoals90 < 0
    ) {
      throw new RangeError('goals must be non-negative safe integers');
    }
    const home = teams.get(score.homeTeamId);
    const away = teams.get(score.awayTeamId);
    if (!home || !away)
      throw new RangeError('every score participant must belong to the baseline');

    if (score.source === 'known-result') {
      addResult(home.known, score.homeGoals90, score.awayGoals90);
      addResult(away.known, score.awayGoals90, score.homeGoals90);
    } else if (score.source === 'simulated') {
      addResult(home.projected, score.homeGoals90, score.awayGoals90);
      addResult(away.projected, score.awayGoals90, score.homeGoals90);
    } else {
      throw new RangeError('score source must be known-result or simulated');
    }
  }

  const rows = [...teams.values()];
  if (
    rows.some((row) =>
      countFields.some((field) => row.known[field] !== row.baseline[field]),
    )
  ) {
    return null;
  }
  return rows.map(({ projected, pointsAdjustment }) => {
    validateStats(projected);
    return {
      ...projected,
      goalDifference: projected.goalsFor - projected.goalsAgainst,
      pointsAdjustment,
    };
  });
}
