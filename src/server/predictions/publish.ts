import 'server-only';

import { sql } from 'drizzle-orm';

import { calculateMatchProbabilities } from '@/lib/model/match-probabilities';
import { canPublishPrediction } from '@/lib/model/prediction-eligibility';

import { db } from '../db/client';
import { matches, predictions } from '../db/schema';
import { predictionInputSchema, type PredictionInput } from './input';

export type PredictionToPublish = PredictionInput;

/**
 * Return the new row ID, or null for an ineligible fixture, budget or retry.
 * Publication time is captured after locking the current fixture.
 */
export async function publishPrediction(
  input: Readonly<PredictionToPublish>,
): Promise<number | null> {
  const parsed = predictionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RangeError('invalid prediction input');
  }

  const { fixture, modelVersion, dataCutoff, expectedGoals, modelOptions } =
    parsed.data;
  const probabilities = calculateMatchProbabilities(
    expectedGoals.home,
    expectedGoals.away,
    modelOptions.distribution,
  );
  const calculatedAt = new Date();
  if (
    probabilities === null ||
    !canPublishPrediction(fixture, {
      dataCutoff,
      calculatedAt,
      publishedAt: calculatedAt,
    })
  ) {
    return null;
  }

  try {
    const result = await db.execute<{ id: number }>(sql`
      WITH locked_fixture AS MATERIALIZED (
        SELECT ${matches.id} AS id, ${matches.status} AS status,
          ${matches.utcDate} AS utc_date,
          ${matches.homeTeamId} AS home_team_id,
          ${matches.awayTeamId} AS away_team_id
        FROM ${matches}
        WHERE ${matches.id} = ${fixture.id}
        FOR UPDATE
      ), receipt AS MATERIALIZED (
        SELECT clock_timestamp() AS at FROM locked_fixture
      )
      INSERT INTO ${predictions} (
        match_id, source, model_version, home_team_id, away_team_id,
        kickoff_at, data_cutoff, calculated_at, recorded_at, published_at,
        expected_goals, probabilities, model_options
      )
      SELECT f.id, 'published', ${modelVersion}, f.home_team_id, f.away_team_id,
        f.utc_date, ${dataCutoff.toISOString()}::timestamptz,
        ${calculatedAt.toISOString()}::timestamptz, r.at, r.at,
        ${JSON.stringify(expectedGoals)}::jsonb,
        ${JSON.stringify(probabilities)}::jsonb,
        ${JSON.stringify(modelOptions)}::jsonb
      FROM locked_fixture f CROSS JOIN receipt r
      WHERE f.status IN ('SCHEDULED', 'TIMED')
        AND f.home_team_id = ${fixture.homeTeamId}
        AND f.away_team_id = ${fixture.awayTeamId}
        AND f.utc_date = ${fixture.utcDate.toISOString()}::timestamptz
        AND ${calculatedAt.toISOString()}::timestamptz <= r.at
        AND r.at < f.utc_date
      ON CONFLICT (
        match_id, source, model_version, home_team_id, away_team_id,
        kickoff_at, data_cutoff
      ) DO NOTHING
      RETURNING id
    `);
    return result.rows[0]?.id ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('prediction could not be published');
  }
}
