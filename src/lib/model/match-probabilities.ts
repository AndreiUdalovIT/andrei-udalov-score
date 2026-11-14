import type { Outcome } from '@/lib/types/football';

import { roundOutcomePercentages } from './outcome-percentages';
import { poissonProbability } from './poisson';
import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  calculateScoreDistribution,
  type ScoreDistribution,
} from './score-distribution';

export type MostLikelyScore = {
  homeGoals: number;
  awayGoals: number;
  probability: number;
};

export type MatchProbabilities = ScoreDistribution & {
  outcomes: Readonly<Record<Outcome, number>>;
  percentages: Readonly<Record<Outcome, number>>;
  over25: number;
  bothTeamsToScore: number;
  topScores: readonly MostLikelyScore[];
};

type ProbabilitySum = { value: number; correction: number };

function addProbability(sum: ProbabilitySum, probability: number): void {
  // Kahan summation preserves contributions from small score probabilities.
  const corrected = probability - sum.correction;
  const total = sum.value + corrected;
  sum.correction = total - sum.value - corrected;
  sum.value = total;
}

function logRatio(numerator: number, denominator: number): number {
  const relative = (numerator - denominator) / denominator;
  if (Math.abs(relative) < 0.5) return Math.log1p(relative);
  return Math.log(numerator) - Math.log(denominator);
}

function goalCandidates(rate: number) {
  const mode = Math.floor(rate);
  const candidates = [{ goals: mode, logWeight: 0 }];
  if (rate === 0) return candidates;

  let logWeight = 0;
  for (let goals = mode - 1; goals >= Math.max(0, mode - 2); goals -= 1) {
    logWeight += logRatio(goals + 1, rate);
    candidates.push({ goals, logWeight });
  }
  logWeight = 0;
  for (let goals = mode + 1; goals <= mode + 2; goals += 1) {
    logWeight += logRatio(rate, goals);
    candidates.push({ goals, logWeight });
  }
  return candidates;
}

function mostLikelyScores(homeRate: number, awayRate: number): MostLikelyScore[] {
  // Each marginal's top three counts lie within two steps of its mode.
  const awayCandidates = goalCandidates(awayRate);
  const candidates = goalCandidates(homeRate).flatMap((home) =>
    awayCandidates.map((away) => ({
      homeGoals: home.goals,
      awayGoals: away.goals,
      logWeight: home.logWeight + away.logWeight,
    })),
  );
  candidates.sort(
    (left, right) =>
      right.logWeight - left.logWeight ||
      left.homeGoals + left.awayGoals - (right.homeGoals + right.awayGoals) ||
      left.homeGoals - right.homeGoals,
  );
  return candidates.slice(0, 3).map(({ homeGoals, awayGoals }) => ({
    homeGoals,
    awayGoals,
    probability:
      poissonProbability(homeGoals, homeRate) *
      poissonProbability(awayGoals, awayRate),
  }));
}

/**
 * Sum market probabilities over the retained score matrix.
 * Each discarded market contribution is bounded by tailUpperBound, subject to
 * floating-point arithmetic. Clamp market sums to [0, 1] for round-off.
 * Top scores use mode neighborhoods and can lie beyond the retained matrix.
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

  const outcomes = {
    home: Math.min(1, sums.home.value),
    draw: Math.min(1, sums.draw.value),
    away: Math.min(1, sums.away.value),
  };
  return {
    ...distribution,
    outcomes,
    percentages: roundOutcomePercentages(outcomes),
    over25: Math.min(1, sums.over25.value),
    bothTeamsToScore: Math.min(1, sums.bothTeamsToScore.value),
    topScores: mostLikelyScores(homeRate, awayRate),
  };
}
