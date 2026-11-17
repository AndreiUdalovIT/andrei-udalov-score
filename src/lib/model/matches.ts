import type { VenueMatch } from '@/lib/football/venue-stats';

export const RECONSTRUCTED_RESULT_DELAY_HOURS = 24;

export type ModelMatch = VenueMatch & {
  id: number;
  utcDate: Date;
  lastUpdated: Date;
  /** Database receipt time of the supplied observed match state. */
  observedAt?: Date;
  /** Explicit or reconstructed availability of the supplied score version. */
  resultAvailableAt?: Date;
};

export type TrainingMatch = ModelMatch & {
  status: 'FINISHED';
  homeTeamId: number;
  awayTeamId: number;
  homeGoals90: number;
  awayGoals90: number;
};

/**
 * The caller scopes matches to the intended competition, seasons and stages.
 * The cutoff is exclusive for kickoff and result availability.
 * Recorded observations take priority over explicit availability and API times.
 * Explicit and API availability require an API update after kickoff.
 */
export function selectTrainingMatches(
  matches: readonly ModelMatch[],
  before: Date,
): TrainingMatch[] {
  const cutoff = before.getTime();
  if (!Number.isFinite(cutoff)) {
    throw new RangeError('before must be a valid date');
  }

  return matches.filter((match): match is TrainingMatch => {
    const kickoff = match.utcDate.getTime();
    const updatedAt = match.lastUpdated.getTime();
    const availableAt = (
      match.observedAt ??
      match.resultAvailableAt ??
      match.lastUpdated
    ).getTime();

    return (
      match.status === 'FINISHED' &&
      match.homeTeamId !== null &&
      match.awayTeamId !== null &&
      match.homeTeamId !== match.awayTeamId &&
      match.homeGoals90 !== null &&
      match.awayGoals90 !== null &&
      Number.isSafeInteger(match.homeGoals90) &&
      Number.isSafeInteger(match.awayGoals90) &&
      match.homeGoals90 >= 0 &&
      match.awayGoals90 >= 0 &&
      (match.observedAt !== undefined || updatedAt > kickoff) &&
      availableAt > kickoff &&
      availableAt < cutoff
    );
  });
}

/**
 * Retrospective availability assumes a final score 24 hours after kickoff.
 * The supplied current score version includes any later corrections.
 * Recorded observation times take priority during training selection.
 */
export function reconstructResultAvailability<MatchRecord extends ModelMatch>(
  matches: readonly MatchRecord[],
) {
  return matches.map((match) => ({
    ...match,
    resultAvailableAt: new Date(
      match.utcDate.getTime() + RECONSTRUCTED_RESULT_DELAY_HOURS * 3_600_000,
    ),
  }));
}
