import { halfPoissonDeviance, poissonProbability } from './poisson';

export type PoissonDistributionOptions = {
  tailTolerance: number;
  maxGoals: number;
};

export type PoissonDistribution = {
  probabilities: readonly number[];
  tailUpperBound: number;
};

function upperTailBound(rate: number, lastGoal: number): number {
  if (rate === 0) return 0;

  const nextGoal = lastGoal + 1;
  if (nextGoal <= rate) return 1;

  // Chernoff bound for P(X >= nextGoal), where nextGoal > rate.
  // Preserve a positive bound when exponentiation underflows.
  return Math.max(Number.MIN_VALUE, Math.exp(-halfPoissonDeviance(nextGoal, rate)));
}

/**
 * Array index k contains P(X = k), with the original probability mass.
 * tailTolerance bounds the discarded upper tail, subject to floating-point
 * arithmetic. maxGoals is the caller's calculation budget.
 * Return null if this bound cannot certify the tolerance within that budget.
 */
export function calculatePoissonDistribution(
  rate: number,
  options: Readonly<PoissonDistributionOptions>,
): PoissonDistribution | null {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError('Poisson rate must be finite and non-negative');
  }

  const { tailTolerance, maxGoals } = options;
  if (!Number.isFinite(tailTolerance) || tailTolerance <= 0 || tailTolerance >= 1) {
    throw new RangeError('tail tolerance must be strictly between zero and one');
  }
  // The support 0..maxGoals must fit within a JavaScript array.
  if (!Number.isInteger(maxGoals) || maxGoals < 0 || maxGoals > 2 ** 32 - 2) {
    throw new RangeError('max goals must be an integer from zero to 2^32 - 2');
  }

  if (upperTailBound(rate, maxGoals) > tailTolerance) return null;

  let lower = 0;
  let upper = maxGoals;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (upperTailBound(rate, middle) <= tailTolerance) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }

  return {
    probabilities: Array.from({ length: lower + 1 }, (_, goals) =>
      poissonProbability(goals, rate),
    ),
    tailUpperBound: upperTailBound(rate, lower),
  };
}
