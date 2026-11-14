import {
  calculatePoissonDistribution,
  type PoissonDistributionOptions,
} from './poisson-distribution';

export type ScoreDistribution = {
  probabilities: readonly (readonly number[])[];
  tailUpperBound: number;
};

/**
 * Independent Poisson goals, indexed as probabilities[homeGoals][awayGoals].
 * tailTolerance applies to the whole matrix, subject to floating-point
 * arithmetic. Each marginal receives half the tolerance, with a positive
 * representable minimum. The sum of marginal tail bounds certifies the result.
 */
export function calculateScoreDistribution(
  homeRate: number,
  awayRate: number,
  options: Readonly<PoissonDistributionOptions>,
): ScoreDistribution | null {
  const { tailTolerance, maxGoals } = options;
  if (!Number.isFinite(tailTolerance) || tailTolerance <= 0 || tailTolerance >= 1) {
    throw new RangeError('tail tolerance must be strictly between zero and one');
  }

  const marginalOptions = {
    tailTolerance: Math.max(Number.MIN_VALUE, tailTolerance / 2),
    maxGoals,
  };
  const home = calculatePoissonDistribution(homeRate, marginalOptions);
  const away = calculatePoissonDistribution(awayRate, marginalOptions);
  if (home === null || away === null) return null;

  const tailUpperBound = home.tailUpperBound + away.tailUpperBound;
  if (tailUpperBound > tailTolerance) return null;

  return {
    probabilities: home.probabilities.map((homeProbability) =>
      away.probabilities.map((awayProbability) => homeProbability * awayProbability),
    ),
    tailUpperBound,
  };
}
