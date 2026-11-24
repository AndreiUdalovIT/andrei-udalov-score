import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seasonForecasts } from './schema';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
const valid = {
  competitionId: 2021,
  season: 2026,
  kind: 'league-table',
  modelVersion: 'test-model-v1',
  dataCutoff: '2026-11-23T18:00:00Z',
  calculatedAt: '2026-11-23T18:01:00Z',
  seed: '{4294967295,0,2147483648,1}',
  runs: 10000,
  forecast: '{"algorithm":"test-forecast","teams":[]}',
};

let client: PGlite;
let database: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client, { casing: 'snake_case' });
  await migrate(database, { migrationsFolder });
  await client.exec(
    "INSERT INTO competitions (id, code, name) VALUES (2021, 'PL', 'Premier League'), (2001, 'CL', 'Champions League')",
  );
}, 15_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec('TRUNCATE season_forecasts RESTART IDENTITY');
});

function insert(overrides: Partial<typeof valid> = {}) {
  const row = { ...valid, ...overrides };
  return client.query(INSERT_SQL, [
    row.competitionId,
    row.season,
    row.kind,
    row.modelVersion,
    row.dataCutoff,
    row.calculatedAt,
    row.seed,
    row.runs,
    row.forecast,
  ]);
}

const INSERT_SQL =
  'INSERT INTO season_forecasts (competition_id, season, kind, model_version, data_cutoff, calculated_at, seed, runs, forecast) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)';

describe('season forecast migration', () => {
  it('stores both forecast kinds and preserves unsigned seed words through Drizzle', async () => {
    await insert();
    await insert({
      competitionId: 2001,
      kind: 'champions-league-stages',
      runs: 250,
    });
    const rows = await database
      .select()
      .from(seasonForecasts)
      .orderBy(seasonForecasts.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      competitionId: 2021,
      season: 2026,
      kind: 'league-table',
      modelVersion: 'test-model-v1',
      dataCutoff: new Date(valid.dataCutoff),
      calculatedAt: new Date(valid.calculatedAt),
      seed: [4294967295, 0, 2147483648, 1],
      runs: 10000,
      forecast: { algorithm: 'test-forecast', teams: [] },
    });
    expect(rows[0]!.recordedAt.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.calculatedAt.getTime(),
    );
    expect(rows[1]).toMatchObject({
      competitionId: 2001,
      kind: 'champions-league-stages',
      runs: 250,
    });
  });

  it.each([
    '{}',
    '{1,2,3}',
    '{0,0,0,0}',
    '{-1,0,0,1}',
    '{4294967296,0,0,1}',
    '{1,2,NULL,4}',
    '{{1,2},{3,4}}',
    '[0:3]={1,2,3,4}',
  ])('rejects an invalid seed %s', async (seed) => {
    await expect(insert({ seed })).rejects.toThrow(/season_forecasts_seed_check/);
  });

  it('rejects invalid timing and incomplete forecast metadata', async () => {
    await expect(insert({ calculatedAt: '2026-11-23T17:59:00Z' })).rejects.toThrow(
      /season_forecasts_times_check/,
    );
    await expect(insert({ calculatedAt: 'infinity' })).rejects.toThrow(
      /season_forecasts_times_check/,
    );
    await expect(insert({ runs: 0 })).rejects.toThrow(
      /season_forecasts_season_runs_check/,
    );
    await expect(insert({ modelVersion: '   ' })).rejects.toThrow(
      /season_forecasts_version_check/,
    );
    await expect(insert({ kind: 'unknown' })).rejects.toThrow(
      /season_forecasts_kind_check/,
    );
    await expect(insert({ forecast: '[]' })).rejects.toThrow(
      /season_forecasts_payload_check/,
    );
    await expect(insert({ competitionId: 9999 })).rejects.toThrow(
      /season_forecasts_competition_id_competitions_id_fk/,
    );
  });
});
