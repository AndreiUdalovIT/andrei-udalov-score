import type { ExpectedGoals } from './expected-goals';
import type { GoalValidationRow } from './goal-validation';
import {
  selectTrainingMatches,
  type ModelMatch,
  type TrainingMatch,
} from './matches';

export type GoalForecastFixture = Pick<
  TrainingMatch,
  'id' | 'homeTeamId' | 'awayTeamId'
> & {
  before: Date;
};

export type GoalValidationWindow = {
  from: Date;
  until: Date;
  resultsBefore: Date;
};

export type WalkForwardGoalRow = GoalValidationRow & {
  before: Date;
};

/**
 * Retrospective outcomes in [from, until), with lastUpdated < resultsBefore.
 * The caller scopes fixtures to the intended competition, seasons and stages.
 * The forecaster receives fixture identity and an exclusive training cutoff
 * at kickoff. Earlier result revisions require separately captured versions.
 */
export async function buildWalkForwardGoalForecasts(
  matches: readonly ModelMatch[],
  { from, until, resultsBefore }: GoalValidationWindow,
  forecast: (
    fixture: GoalForecastFixture,
  ) => ExpectedGoals | null | Promise<ExpectedGoals | null>,
): Promise<WalkForwardGoalRow[]> {
  const start = from.getTime();
  const end = until.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError('validation window must have valid dates and from < until');
  }

  const selected = selectTrainingMatches(matches, resultsBefore)
    .filter(
      (match) => match.utcDate.getTime() >= start && match.utcDate.getTime() < end,
    )
    .sort((a, b) => a.utcDate.getTime() - b.utcDate.getTime() || a.id - b.id);
  if (new Set(selected.map((match) => match.id)).size !== selected.length) {
    throw new RangeError('validation match IDs must be unique');
  }

  const rows: WalkForwardGoalRow[] = [];
  for (const match of selected) {
    const before = new Date(match.utcDate.getTime());
    const expectedGoals = await forecast({
      id: match.id,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      before: new Date(before.getTime()),
    });

    rows.push({
      id: match.id,
      before,
      homeGoals90: match.homeGoals90,
      awayGoals90: match.awayGoals90,
      expectedGoals,
    });
  }

  return rows;
}
