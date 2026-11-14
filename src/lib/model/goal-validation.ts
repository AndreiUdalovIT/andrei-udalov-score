import type { ExpectedGoals } from './expected-goals';
import type { TrainingMatch } from './matches';

export type GoalValidationRow = Pick<
  TrainingMatch,
  'id' | 'homeGoals90' | 'awayGoals90'
> & {
  expectedGoals: ExpectedGoals | null;
};

function halfPoissonDeviance(observed: number, expected: number): number {
  if (!Number.isFinite(expected) || expected < 0) {
    throw new RangeError('expected goals must be finite and non-negative');
  }
  if (observed === 0) return expected;
  if (expected === 0) return Infinity;

  const relative = (expected - observed) / observed;
  if (Math.abs(relative) < 0.5) {
    // Retain tiny losses when the rate nearly equals the observed count.
    if (Math.abs(relative) < 1e-4) {
      return (
        observed *
        relative *
        relative *
        (0.5 - relative / 3 + (relative * relative) / 4)
      );
    }
    return observed * (relative - Math.log1p(relative));
  }

  return expected - observed + observed * (Math.log(observed) - Math.log(expected));
}

/**
 * Score one forecast per match, over both goal observations.
 * The caller builds forecasts with a pre-kickoff training cutoff and compares
 * settings on a common match set. Missing forecasts are counted as unavailable.
 */
export function scoreGoalForecasts(rows: readonly GoalValidationRow[]) {
  const seen = new Set<number>();
  let forecastCount = 0;
  let lowDataCount = 0;
  let homeMean = 0;
  let awayMean = 0;

  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new RangeError('validation match IDs must be unique');
    }
    seen.add(row.id);
    if (
      !Number.isSafeInteger(row.homeGoals90) ||
      !Number.isSafeInteger(row.awayGoals90) ||
      row.homeGoals90 < 0 ||
      row.awayGoals90 < 0
    ) {
      throw new RangeError('validation scores must be non-negative safe integers');
    }

    const prediction = row.expectedGoals;
    if (prediction === null) continue;
    const homeLoss = halfPoissonDeviance(row.homeGoals90, prediction.home);
    const awayLoss = halfPoissonDeviance(row.awayGoals90, prediction.away);
    forecastCount += 1;
    if (prediction.lowData) lowDataCount += 1;

    // Average each half-deviance before adding the two sides.
    const previousWeight = (forecastCount - 1) / forecastCount;
    homeMean = homeMean * previousWeight + homeLoss / forecastCount;
    awayMean = awayMean * previousWeight + awayLoss / forecastCount;
  }

  return {
    matchCount: rows.length,
    forecastCount,
    lowDataCount,
    meanPoissonDeviance: forecastCount === 0 ? null : homeMean + awayMean,
  };
}
