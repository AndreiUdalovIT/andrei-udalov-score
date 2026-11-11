import { selectTrainingMatches, type ModelMatch } from './matches';

export type LeagueAverages = {
  matchCount: number;
  /** Effective sample size from the match weights. */
  effectiveMatchCount: number;
  homeGoalsPerMatch: number;
  awayGoalsPerMatch: number;
};

/** The caller selects the competition, seasons and stages for the sample. */
export function calculateLeagueAverages(
  matches: readonly ModelMatch[],
  before: Date,
  halfLifeDays: number,
): LeagueAverages | null {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be finite and positive');
  }

  const selected = selectTrainingMatches(matches, before);
  if (selected.length === 0) return null;

  // A shared weight scale cancels out of the averages and avoids underflow.
  const referenceTime = selected.reduce(
    (latest, match) => Math.max(latest, match.utcDate.getTime()),
    -Infinity,
  );
  let weightSum = 0;
  let squaredWeightSum = 0;
  let homeGoals = 0;
  let awayGoals = 0;

  for (const match of selected) {
    const ageDays = (referenceTime - match.utcDate.getTime()) / 86_400_000;
    const weight = 2 ** (-ageDays / halfLifeDays);

    weightSum += weight;
    squaredWeightSum += weight * weight;
    homeGoals += match.homeGoals90 * weight;
    awayGoals += match.awayGoals90 * weight;
  }

  return {
    matchCount: selected.length,
    effectiveMatchCount: Math.min(
      selected.length,
      (weightSum * weightSum) / squaredWeightSum,
    ),
    homeGoalsPerMatch: homeGoals / weightSum,
    awayGoalsPerMatch: awayGoals / weightSum,
  };
}
