import 'server-only';

import { setImmediate } from 'node:timers/promises';
import { sql } from 'drizzle-orm';

import type { SiteCompetitionCode } from '@/lib/config/competitions';
import {
  createChampionsLeagueForecast,
  type ChampionsLeagueForecastInput,
  type ChampionsLeagueForecastUnavailability,
} from '@/lib/model/champions-league-forecast';
import {
  createLeagueSimulation,
  type LeagueSimulationInput,
  type LeagueSimulationUnavailability,
} from '@/lib/model/league-simulation';

import { db } from '../db/client';
import {
  competitions,
  seasonForecasts,
  type SeasonForecastKind,
} from '../db/schema';

export const DEFAULT_SEASON_FORECAST_RUNS = 10_000;
const runsPerBatch = 100;

type WithOptionalRuns<Input extends { runs: number }> = Omit<Input, 'runs'> & {
  readonly runs?: number;
};

export type SeasonForecastRequest =
  | {
      readonly kind: 'league-table';
      readonly input: WithOptionalRuns<LeagueSimulationInput>;
    }
  | {
      readonly kind: 'champions-league-stages';
      readonly input: WithOptionalRuns<ChampionsLeagueForecastInput>;
    };

export type SeasonForecastStorageResult =
  | { status: 'stored'; id: number }
  | { status: 'unsupported' | 'competition-missing' }
  | {
      status: 'unavailable';
      detail: LeagueSimulationUnavailability | ChampionsLeagueForecastUnavailability;
    };

type StoredForecast = (typeof seasonForecasts.$inferInsert)['forecast'];

async function storeForecast(
  competitionCode: SiteCompetitionCode,
  kind: SeasonForecastKind,
  forecast: StoredForecast,
): Promise<SeasonForecastStorageResult> {
  const { season, modelVersion, dataCutoffMs, seed, runs } = forecast.inputSnapshot;
  const calculatedAt = new Date().toISOString();
  const dataCutoff = new Date(dataCutoffMs).toISOString();
  const seedLiteral = '{' + seed.join(',') + '}';

  try {
    // The lookup takes a fresh snapshot after any earlier writer releases the lock.
    const [, , result] = await db.batch([
      db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`),
      db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('season_forecasts'), hashtext(${competitionCode}))`,
      ),
      db.execute<{ id: number }>(sql`
        WITH candidate AS MATERIALIZED (
          SELECT ${competitions.id} AS competition_id, ${season}::integer AS season,
            ${kind}::text AS kind, ${modelVersion}::text AS model_version,
            ${dataCutoff}::timestamptz AS data_cutoff, ${calculatedAt}::timestamptz AS calculated_at,
            ${seedLiteral}::bigint[] AS seed, ${runs}::integer AS runs,
            ${JSON.stringify(forecast)}::jsonb AS forecast
          FROM ${competitions}
          WHERE ${competitions.code} = ${competitionCode}
        ), existing AS MATERIALIZED (
          SELECT ${seasonForecasts.id} AS id
          FROM ${seasonForecasts} JOIN candidate c ON ${seasonForecasts.competitionId} = c.competition_id
          WHERE ${seasonForecasts.season} = c.season
            AND ${seasonForecasts.kind} = c.kind
            AND ${seasonForecasts.modelVersion} = c.model_version
            AND ${seasonForecasts.dataCutoff} = c.data_cutoff
            AND ${seasonForecasts.seed} = c.seed
            AND ${seasonForecasts.runs} = c.runs
            AND ${seasonForecasts.forecast} = c.forecast
          ORDER BY ${seasonForecasts.id}
          LIMIT 1
        ), inserted AS (
          INSERT INTO ${seasonForecasts} (
            competition_id, season, kind, model_version, data_cutoff, calculated_at, seed, runs, forecast
          )
          SELECT competition_id, season, kind, model_version, data_cutoff, calculated_at, seed, runs, forecast
          FROM candidate
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING id
        )
        SELECT id FROM inserted UNION ALL SELECT id FROM existing
      `),
    ]);
    const row = result.rows[0];
    return row === undefined
      ? { status: 'competition-missing' }
      : { status: 'stored', id: row.id };
  } catch {
    // Driver errors can include connection details or parameters.
    throw new Error('season forecast could not be stored');
  }
}

/** Calculate from a caller-prepared snapshot and store a complete result. */
export async function calculateAndStoreSeasonForecast(
  request: SeasonForecastRequest,
): Promise<SeasonForecastStorageResult> {
  const runs = request.input.runs ?? DEFAULT_SEASON_FORECAST_RUNS;
  if (!Number.isInteger(runs) || runs <= 0 || runs > 2_147_483_647)
    throw new RangeError('runs must be a positive PostgreSQL integer');
  if (request.input.dataCutoffMs > Date.now())
    throw new RangeError('season forecast cutoff must not be in the future');

  const kind = request.kind;
  const competitionCode =
    request.kind === 'league-table' ? request.input.competitionCode : 'CL';
  const job =
    request.kind === 'league-table'
      ? createLeagueSimulation({ ...request.input, runs })
      : createChampionsLeagueForecast({ ...request.input, runs });
  if (job === null) return { status: 'unsupported' };

  while (job.status === 'ready' || job.status === 'running') {
    job.advance(runsPerBatch);
    if (job.status === 'running') await setImmediate();
  }

  const detail = job.unavailability;
  if (detail !== null) return { status: 'unavailable', detail };
  const result = job.result();
  if (result === null) throw new Error('season forecast did not complete');
  return storeForecast(competitionCode, kind, result);
}
