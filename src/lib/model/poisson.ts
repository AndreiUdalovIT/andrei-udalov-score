/**
 * Half the Poisson deviance for a non-negative safe integer observation.
 * Shared by forecast validation and probability calculations.
 */
export function halfPoissonDeviance(observed: number, expected: number): number {
  if (!Number.isSafeInteger(observed) || observed < 0) {
    throw new RangeError('observed goals must be a non-negative safe integer');
  }
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

/** Probability of exactly goals events at a finite, non-negative Poisson rate. */
export function poissonProbability(goals: number, rate: number): number {
  const deviance = halfPoissonDeviance(goals, rate);
  if (goals === 0) return Math.exp(-deviance);

  if (goals < 16) {
    let factorial = 1;
    for (let count = 2; count <= goals; count += 1) factorial *= count;
    return Math.exp(goals * Math.log(rate) - rate - Math.log(factorial));
  }

  // Stirling's series through goals^-9, with a first omitted term below
  // 1.1e-16 for goals >= 16. https://dlmf.nist.gov/5.11#E1
  const inverse = 1 / goals;
  const correction =
    inverse / 12 -
    inverse ** 3 / 360 +
    inverse ** 5 / 1260 -
    inverse ** 7 / 1680 +
    inverse ** 9 / 1188;

  // The deviance form retains precision near the mode at large rates.
  return Math.exp(-deviance - Math.log(2 * Math.PI * goals) / 2 - correction);
}
