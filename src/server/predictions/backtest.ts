import 'server-only';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CompetitionCode } from '@/lib/config/competitions';
import type { GoalValidationWindow } from '@/lib/model/goal-walk-forward';
import { calculateMatchProbabilities } from '@/lib/model/match-probabilities';

import { db } from '../db/client';
import { matches, matchObservations, predictions } from '../db/schema';
import { loadObservedCompetitionGoalForecasts } from '../queries/strengths';
import { predictionInputSchema, type PredictionInput } from './input';

export type BacktestPredictionToStore = Omit<PredictionInput, 'fixture'> & {
  fixture: Omit<PredictionInput['fixture'], 'status'>;
};

const backtestInputSchema = predictionInputSchema.omit({ fixture: true }).extend({
  fixture: predictionInputSchema.shape.fixture.omit({ status: true }),
}) satisfies z.ZodType<BacktestPredictionToStore>;

const backtestModelSchema = predictionInputSchema.pick({
  modelVersion: true,
  modelOptions: true,
});

export type ObservedBacktestSettings = Pick<
  PredictionInput,
  'modelVersion' | 'modelOptions'
> & {
  signal?: AbortSignal;
};

/** Store an observed retrospective forecast with its actual calculation time. */
export async function storeObservedBacktestPrediction(
  input: Readonly<BacktestPredictionToStore>,
): Promise<number | null> {
  const parsed = backtestInputSchema.safeParse(input);
  if (!parsed.success) throw new RangeError('invalid backtest prediction input');

  const { modelVersion, expectedGoals, modelOptions } = parsed.data;
  const fixture = {
    ...parsed.data.fixture,
    utcDate: new Date(parsed.data.fixture.utcDate.getTime()),
  };
  const dataCutoff = new Date(parsed.data.dataCutoff.getTime());
  const probabilities = calculateMatchProbabilities(
    expectedGoals.home,
    expectedGoals.away,
    modelOptions.distribution,
  );
  const calculatedAt = new Date();
  if (
    probabilities === null ||
    dataCutoff > fixture.utcDate ||
    dataCutoff > calculatedAt
  )
    return null;

  const storedOptions: (typeof predictions.$inferInsert)['modelOptions'] = {
    ...modelOptions,
    resultAvailability: { mode: 'observed', delayHours: null },
  };
  try {
    const result = await db.execute<{ id: number }>(sql`
      WITH locked_match AS MATERIALIZED (
        SELECT ${matches.id} AS id FROM ${matches}
        WHERE ${matches.id} = ${fixture.id}
        FOR KEY SHARE
      ), historical_fixture AS MATERIALIZED (
        SELECT o.match_id, o.status, o.utc_date, o.home_team_id, o.away_team_id
        FROM ${matchObservations} o
        INNER JOIN locked_match m ON o.match_id = m.id
        WHERE o.observed_at < ${dataCutoff.toISOString()}::timestamptz
        ORDER BY o.observed_at DESC, o.id DESC
        LIMIT 1
      ), receipt AS MATERIALIZED (
        SELECT clock_timestamp() AS at FROM historical_fixture
      )
      INSERT INTO ${predictions} (
        match_id, source, model_version, home_team_id, away_team_id,
        kickoff_at, data_cutoff, calculated_at, recorded_at, published_at,
        expected_goals, probabilities, model_options
      )
      SELECT f.match_id, 'backtest', ${modelVersion}, f.home_team_id, f.away_team_id,
        f.utc_date, ${dataCutoff.toISOString()}::timestamptz,
        ${calculatedAt.toISOString()}::timestamptz, r.at, NULL,
        ${JSON.stringify(expectedGoals)}::jsonb,
        ${JSON.stringify(probabilities)}::jsonb,
        ${JSON.stringify(storedOptions)}::jsonb
      FROM historical_fixture f CROSS JOIN receipt r
      WHERE f.status IN ('SCHEDULED', 'TIMED')
        AND f.home_team_id = ${fixture.homeTeamId}
        AND f.away_team_id = ${fixture.awayTeamId}
        AND f.home_team_id <> f.away_team_id
        AND f.utc_date = ${fixture.utcDate.toISOString()}::timestamptz
        AND ${calculatedAt.toISOString()}::timestamptz <= r.at
      ON CONFLICT (
        match_id, source, model_version, home_team_id, away_team_id,
        kickoff_at, data_cutoff
      ) DO NOTHING
      RETURNING id
    `);
    return result.rows[0]?.id ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('backtest prediction could not be stored');
  }
}

/** Calculate and store observed walk-forward forecasts for one competition. */
export async function storeObservedCompetitionBacktest(
  competitionCode: CompetitionCode,
  season: number,
  window: GoalValidationWindow,
  settings: Readonly<ObservedBacktestSettings>,
) {
  const parsed = backtestModelSchema.safeParse(settings);
  if (!parsed.success) throw new RangeError('invalid backtest model settings');
  const { modelVersion, modelOptions } = parsed.data;
  const { signal } = settings;
  signal?.throwIfAborted();
  const forecast = await loadObservedCompetitionGoalForecasts(
    competitionCode,
    season,
    window,
    modelOptions.strengths,
  );
  signal?.throwIfAborted();
  if (forecast === null) return null;

  let forecastCount = 0;
  let storedCount = 0;
  for (const row of forecast.rows) {
    signal?.throwIfAborted();
    if (row.expectedGoals === null) continue;
    forecastCount += 1;
    const id = await storeObservedBacktestPrediction({
      fixture: {
        id: row.id,
        utcDate: row.before,
        homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId,
      },
      dataCutoff: row.before,
      modelVersion,
      expectedGoals: row.expectedGoals,
      modelOptions: {
        strengths: forecast.options,
        distribution: modelOptions.distribution,
      },
    });
    if (id !== null) storedCount += 1;
  }
  signal?.throwIfAborted();
  return {
    matchCount: forecast.rows.length,
    forecastCount,
    storedCount,
    skippedCount: forecastCount - storedCount,
    unavailableCount: forecast.rows.length - forecastCount,
  };
}
