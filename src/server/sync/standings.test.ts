import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/standings.json';
import { standingsResponseSchema } from '@/lib/football-data/schemas/standings';

import { syncCompetitionStandings } from './standings';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  getCompetitionStandings:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetitionStandings']>(),
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<void>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getCompetitionStandings: mocks.getCompetitionStandings,
  }),
}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

const response = standingsResponseSchema.parse(fixture.league);

function getQueries() {
  const queries = mocks.batch.mock.calls[0]?.[0];
  if (!queries) throw new Error('Missing captured batch');
  return queries.map((query) => query.toSQL());
}

beforeEach(() => {
  mocks.getCompetitionStandings.mockReset().mockResolvedValue(response);
  mocks.batch.mockReset().mockResolvedValue(undefined);
});

describe('competition standings sync', () => {
  it('waits for API data and replaces the scoped snapshot with official points', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getCompetitionStandings.mockReturnValueOnce(pending.promise);

    const result = syncCompetitionStandings('PL');
    expect(mocks.batch).not.toHaveBeenCalled();
    pending.resolve({
      ...response,
      standings: response.standings.map((standing) => ({
        ...standing,
        table: standing.table.map((row, index) => ({
          ...row,
          points: index === 0 ? -3 : row.points,
        })),
      })),
    });

    await expect(result).resolves.toEqual({
      competitionCode: 'PL',
      season: 2026,
      rowCount: 2,
    });
    expect(mocks.getCompetitionStandings).toHaveBeenCalledWith('PL', {
      season: undefined,
      signal: undefined,
    });
    expect(mocks.batch).toHaveBeenCalledOnce();

    const queries = getQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain(
      'delete from "standings" where ("standings"."competition_id" = $1 and "standings"."season" = $2)',
    );
    expect(queries[0]?.params).toEqual([2021, 2026]);
    expect(queries[1]?.sql).toContain('insert into "standings"');
    expect(queries[1]?.params.slice(0, 3)).toEqual([2021, 2026, 57]);
    expect(queries[1]?.params[8]).toBe(-3);
    expect(queries[1]?.params.slice(11, 13)).toEqual(['REGULAR_SEASON', 'Matchday']);
    expect(queries[1]?.params[15]).toBe(71);
  });

  it('replaces only the requested historical season', async () => {
    mocks.getCompetitionStandings.mockResolvedValue({
      ...response,
      season: {
        ...response.season,
        startDate: '2024-08-16',
        endDate: '2025-05-25',
        currentMatchday: 38,
      },
    });

    await syncCompetitionStandings('PL', { season: 2024 });

    expect(mocks.getCompetitionStandings).toHaveBeenCalledWith('PL', {
      season: 2024,
      signal: undefined,
    });
    const queries = getQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.params).toEqual([2021, 2024]);
    expect(queries[1]?.params.slice(0, 3)).toEqual([2021, 2024, 57]);
  });

  it.each([
    { label: 'no tables', standings: [] },
    {
      label: 'an empty TOTAL table',
      standings: response.standings.map((standing) => ({
        ...standing,
        table: [],
      })),
    },
  ])('clears only the scoped season for $label', async ({ standings }) => {
    mocks.getCompetitionStandings.mockResolvedValue({ ...response, standings });

    await expect(syncCompetitionStandings('PL')).resolves.toEqual({
      competitionCode: 'PL',
      season: 2026,
      rowCount: 0,
    });

    expect(mocks.batch).toHaveBeenCalledOnce();
    const queries = getQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('delete from "standings"');
    expect(queries[0]?.params).toEqual([2021, 2026]);
  });

  it('rejects a nonempty response without TOTAL before deleting saved rows', async () => {
    mocks.getCompetitionStandings.mockResolvedValue({
      ...response,
      standings: response.standings.map((standing) => ({
        ...standing,
        type: 'HOME' as const,
      })),
    });

    await expect(syncCompetitionStandings('PL')).rejects.toThrow(
      'Standings response has no TOTAL table',
    );
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('preserves an API failure without starting a database batch', async () => {
    const error = new Error('API unavailable');
    mocks.getCompetitionStandings.mockRejectedValue(error);

    await expect(syncCompetitionStandings('PL')).rejects.toBe(error);

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('honors cancellation before writing without exposing its reason', async () => {
    const controller = new AbortController();
    const result = syncCompetitionStandings('PL', { signal: controller.signal });
    controller.abort(new Error('Sensitive abort reason'));

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data standings sync aborted',
    });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('reports a failed write without exposing driver details or retrying it', async () => {
    mocks.batch.mockRejectedValue(new Error('Sensitive database connection'));

    const result = syncCompetitionStandings('PL');

    await expect(result).rejects.toThrow('competition standings could not be saved');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
});
