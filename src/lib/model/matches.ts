import type { VenueMatch } from '@/lib/football/venue-stats';

export type ModelMatch = VenueMatch & {
  id: number;
  utcDate: Date;
  lastUpdated: Date;
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
 * The cutoff is exclusive for kickoff and the latest API update.
 * Historical availability requires separately captured result versions.
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
      updatedAt > kickoff &&
      updatedAt < cutoff
    );
  });
}
