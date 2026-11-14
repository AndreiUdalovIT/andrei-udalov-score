import { scoreGoalForecasts } from './goal-validation';
import type { WalkForwardGoalRow } from './goal-walk-forward';

export type GoalForecastCandidate = {
  id: string;
  rows: readonly WalkForwardGoalRow[];
};

/**
 * Compare candidates on fixtures with a forecast from every candidate.
 * Each candidate supplies the same outcomes and kickoff cutoffs, including
 * rows whose forecast is null. Coverage counts use the entire fixture set.
 * Common metrics include low-data forecasts and infinite Poisson losses.
 */
export function compareGoalForecasts(candidates: readonly GoalForecastCandidate[]) {
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
  ) {
    throw new RangeError('forecast candidate IDs must be unique');
  }

  const reference = [...(candidates[0]?.rows ?? [])].sort(
    (a, b) => a.before.getTime() - b.before.getTime() || a.id - b.id,
  );
  const referenceById = new Map(reference.map((row) => [row.id, row]));
  const indexed = candidates.map((candidate) => {
    const summary = scoreGoalForecasts(candidate.rows);
    if (candidate.rows.length !== reference.length) {
      throw new RangeError(
        'forecast candidates must contain the same validation matches',
      );
    }
    for (const row of candidate.rows) {
      const outcome = referenceById.get(row.id);
      if (
        outcome === undefined ||
        row.homeGoals90 !== outcome.homeGoals90 ||
        row.awayGoals90 !== outcome.awayGoals90 ||
        row.before.getTime() !== outcome.before.getTime()
      ) {
        throw new RangeError(
          'forecast candidates must share outcomes and valid kickoff cutoffs',
        );
      }
    }
    return {
      id: candidate.id,
      byId: new Map(candidate.rows.map((row) => [row.id, row])),
      summary,
    };
  });
  const commonMatchIds = reference
    .filter((row) =>
      indexed.every(
        (candidate) => candidate.byId.get(row.id)!.expectedGoals !== null,
      ),
    )
    .map((row) => row.id);

  return {
    matchCount: reference.length,
    commonMatchIds,
    candidates: indexed.map(({ id, byId, summary }) => {
      const commonRows = commonMatchIds.map((matchId) => byId.get(matchId)!);
      return {
        id,
        forecastCount: summary.forecastCount,
        lowDataCount: summary.lowDataCount,
        common: scoreGoalForecasts(commonRows),
      };
    }),
  };
}
