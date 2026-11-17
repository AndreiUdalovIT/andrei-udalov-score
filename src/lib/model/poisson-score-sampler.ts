import {
  calculatePoissonDistribution,
  type PoissonDistributionOptions,
} from './poisson-distribution';

export const POISSON_SCORE_SAMPLING_ALGORITHM =
  'independent-poisson-conditioned-cdf-v1';

export type SampledScore = {
  homeGoals: number;
  awayGoals: number;
};

export type PoissonScoreSampler = {
  readonly algorithm: typeof POISSON_SCORE_SAMPLING_ALGORITHM;
  /** Bound on discarded score mass, excluding round-off and RNG resolution. */
  readonly tailUpperBound: number;
  /** Each successful sample consumes exactly two values, home then away. */
  readonly sample: (random: () => number) => SampledScore;
};

function createCumulativeProbabilities(
  probabilities: readonly number[],
): number[] | null {
  let mass = 0;
  const cumulative = probabilities.map((probability) => (mass += probability));
  if (!Number.isFinite(mass) || mass <= 0) return null;

  // Condition on the retained support. Positive sums are monotone, and the
  // final boundary is exactly one because the last cumulative value is mass.
  return cumulative.map((probability) => probability / mass);
}

function sampleGoals(cumulative: readonly number[], uniform: number): number {
  if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1) {
    throw new RangeError('random values must be finite and in [0, 1)');
  }

  // Find the first boundary strictly above the uniform value. This skips
  // zero-mass entries, including underflowed probabilities at large rates.
  let lower = 0;
  let upper = cumulative.length - 1;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (uniform < cumulative[middle]!) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }
  return lower;
}

/**
 * Precompute independent Poisson marginals once and reuse them across runs.
 * The caller supplies independent uniform values in [0, 1).
 * Sample the distribution conditioned on both retained goal ranges.
 * In exact arithmetic its total variation distance from the full score
 * distribution is at most tailUpperBound. Floating-point arithmetic and the
 * resolution of supplied random values introduce additional approximation.
 * The bound applies to one score; callers must budget it over all sampled scores.
 * Return null if the requested tail tolerance cannot be met within maxGoals
 * or the retained mass cannot be normalized.
 */
export function createPoissonScoreSampler(
  homeRate: number,
  awayRate: number,
  options: Readonly<PoissonDistributionOptions>,
): PoissonScoreSampler | null {
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
  const homeCumulative = createCumulativeProbabilities(home.probabilities);
  const awayCumulative = createCumulativeProbabilities(away.probabilities);
  if (homeCumulative === null || awayCumulative === null) return null;

  return {
    algorithm: POISSON_SCORE_SAMPLING_ALGORITHM,
    tailUpperBound,
    sample(random) {
      return {
        homeGoals: sampleGoals(homeCumulative, random()),
        awayGoals: sampleGoals(awayCumulative, random()),
      };
    },
  };
}
