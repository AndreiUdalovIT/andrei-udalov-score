import type { ExpectedGoals } from './expected-goals';
import type { TrainingMatch } from './matches';
import { halfPoissonDeviance } from './poisson';

export type GoalValidationRow = Pick<
  TrainingMatch,
  'id' | 'homeGoals90' | 'awayGoals90'
> & {
  expectedGoals: ExpectedGoals | null;
};

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
