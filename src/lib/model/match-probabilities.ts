import type { Outcome } from '@/lib/types/football';

import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  calculateScoreDistribution,
  type ScoreDistribution,
} from './score-distribution';

export type MatchProbabilities = ScoreDistribution & {
  outcomes: Readonly<Record<Outcome, number>>;
  over25: number;
  bothTeamsToScore: number;
};

type ProbabilitySum = { value: number; correction: number };

function addProbability(sum: ProbabilitySum, probability: number): void {
  // Kahan summation preserves contributions from small score probabilities.
  const corrected = probability - sum.correction;
  const total = sum.value + corrected;
  sum.correction = total - sum.value - corrected;
  sum.value = total;
}

/**
 * Sum market probabilities over the retained score matrix.
 * Each discarded market contribution is bounded by tailUpperBound, subject to
 * floating-point arithmetic. Clamp market sums to [0, 1] for round-off.
 */
export function calculateMatchProbabilities(
  homeRate: number,
  awayRate: number,
  options: Readonly<PoissonDistributionOptions>,
): MatchProbabilities | null {
  const distribution = calculateScoreDistribution(homeRate, awayRate, options);
  if (distribution === null) return null;

  const sums = {
    home: { value: 0, correction: 0 },
    draw: { value: 0, correction: 0 },
    away: { value: 0, correction: 0 },
    over25: { value: 0, correction: 0 },
    bothTeamsToScore: { value: 0, correction: 0 },
  };
  for (const [homeGoals, row] of distribution.probabilities.entries()) {
    for (const [awayGoals, probability] of row.entries()) {
      if (homeGoals > awayGoals) {
        addProbability(sums.home, probability);
      } else if (homeGoals < awayGoals) {
        addProbability(sums.away, probability);
      } else {
        addProbability(sums.draw, probability);
      }
      if (homeGoals + awayGoals >= 3) addProbability(sums.over25, probability);
      if (homeGoals > 0 && awayGoals > 0) {
        addProbability(sums.bothTeamsToScore, probability);
      }
    }
  }

  return {
    ...distribution,
    outcomes: {
      home: Math.min(1, sums.home.value),
      draw: Math.min(1, sums.draw.value),
      away: Math.min(1, sums.away.value),
    },
    over25: Math.min(1, sums.over25.value),
    bothTeamsToScore: Math.min(1, sums.bothTeamsToScore.value),
  };
}
