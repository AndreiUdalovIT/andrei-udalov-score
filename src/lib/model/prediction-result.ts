import type { VenueMatch } from '@/lib/football/venue-stats';
import type { Outcome } from '@/lib/types/football';

export type PredictionAssessment = {
  outcome: Outcome;
  correct: boolean;
};

/** Assess a completed 90-minute result against the saved raw favorite. */
export function assessPredictionResult(
  match: Readonly<VenueMatch>,
  favorite: Outcome,
): PredictionAssessment | null {
  const { status, homeTeamId, awayTeamId, homeGoals90, awayGoals90 } = match;
  if (
    status !== 'FINISHED' ||
    homeTeamId === null ||
    awayTeamId === null ||
    homeTeamId === awayTeamId ||
    homeGoals90 === null ||
    awayGoals90 === null ||
    !Number.isSafeInteger(homeGoals90) ||
    !Number.isSafeInteger(awayGoals90) ||
    homeGoals90 < 0 ||
    awayGoals90 < 0
  ) {
    return null;
  }

  let outcome: Outcome = 'draw';
  if (homeGoals90 > awayGoals90) {
    outcome = 'home';
  } else if (homeGoals90 < awayGoals90) {
    outcome = 'away';
  }
  return { outcome, correct: outcome === favorite };
}
