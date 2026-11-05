import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/scorers.json';
import { scorersResponseSchema } from '@/lib/football-data/schemas/scorers';

import { syncCompetitionScorers } from './scorers';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  getCompetitionScorers:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetitionScorers']>(),
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<void>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getCompetitionScorers: mocks.getCompetitionScorers,
  }),
}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

const response = scorersResponseSchema.parse(fixture.league);
const firstScorer = response.scorers[0];
if (!firstScorer) throw new Error('Missing scorer fixture');
const fullResponse = {
  ...response,
  scorers: Array.from({ length: 1_000 }, (_, index) => ({
    ...firstScorer,
    player: { ...firstScorer.player, id: 100_000 + index },
  })),
};

function getQueries() {
  const queries = mocks.batch.mock.calls[0]?.[0];
  if (!queries) throw new Error('Missing captured batch');
  return queries.map((query) => query.toSQL());
}

beforeEach(() => {
  mocks.getCompetitionScorers.mockReset().mockResolvedValue(response);
  mocks.batch.mockReset().mockResolvedValue(undefined);
});

describe('competition scorers sync', () => {
  it('waits for API data and replaces the scoped ranking with nulls and zeroes', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getCompetitionScorers.mockReturnValueOnce(pending.promise);

    const result = syncCompetitionScorers('PL');
    expect(mocks.batch).not.toHaveBeenCalled();
    pending.resolve({
      ...response,
      scorers: response.scorers.map((scorer, index) =>
        index === 0 ? scorer : { ...scorer, assists: 0, penalties: 0 },
      ),
    });

    await expect(result).resolves.toEqual({
      competitionCode: 'PL',
      season: 2026,
      rowCount: 2,
    });
    expect(mocks.getCompetitionScorers).toHaveBeenCalledExactlyOnceWith('PL', {
      season: undefined,
      limit: 1_000,
      signal: undefined,
    });
    expect(mocks.batch).toHaveBeenCalledOnce();

    const queries = getQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain(
      'delete from "scorers" where ("scorers"."competition_id" = $1 and "scorers"."season" = $2)',
    );
    expect(queries[0]?.params).toEqual([2021, 2026]);
    expect(queries[1]?.sql).toContain('insert into "scorers"');
    expect(queries[1]?.params.slice(0, 3)).toEqual([2021, 2026, 38101]);
    expect(queries[1]?.params.slice(7, 9)).toEqual([null, null]);
    expect(queries[1]?.params.slice(16, 18)).toEqual([0, 0]);
  });

  it('expands a filled limit and waits for the complete ranking before writing', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getCompetitionScorers
      .mockResolvedValueOnce(fullResponse)
      .mockReturnValueOnce(pending.promise);

    const result = syncCompetitionScorers('PL');
    await vi.waitFor(() =>
      expect(mocks.getCompetitionScorers).toHaveBeenCalledTimes(2),
    );
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.getCompetitionScorers).toHaveBeenNthCalledWith(2, 'PL', {
      season: undefined,
      limit: 2_000,
      signal: undefined,
    });

    pending.resolve(response);
    await expect(result).resolves.toMatchObject({ rowCount: 2 });

    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(getQueries()[1]?.params).toHaveLength(18);
  });

  it('replaces only the requested historical season', async () => {
    mocks.getCompetitionScorers.mockResolvedValue({
      ...response,
      season: {
        ...response.season,
        startDate: '2024-08-16',
        endDate: '2025-05-25',
      },
    });

    await syncCompetitionScorers('PL', { season: 2024 });

    expect(mocks.getCompetitionScorers).toHaveBeenCalledWith('PL', {
      season: 2024,
      limit: 1_000,
      signal: undefined,
    });
    const queries = getQueries();
    expect(queries[0]?.params).toEqual([2021, 2024]);
    expect(queries[1]?.params.slice(0, 3)).toEqual([2021, 2024, 38101]);
  });

  it('clears only the scoped season for an empty ranking', async () => {
    mocks.getCompetitionScorers.mockResolvedValue({ ...response, scorers: [] });

    await expect(syncCompetitionScorers('PL')).resolves.toEqual({
      competitionCode: 'PL',
      season: 2026,
      rowCount: 0,
    });

    expect(mocks.batch).toHaveBeenCalledOnce();
    const queries = getQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('delete from "scorers"');
    expect(queries[0]?.params).toEqual([2021, 2026]);
  });

  it('rejects duplicate players before deleting saved rows', async () => {
    mocks.getCompetitionScorers.mockResolvedValue({
      ...response,
      scorers: [...response.scorers, ...response.scorers],
    });

    await expect(syncCompetitionScorers('PL')).rejects.toThrow(
      'Scorers response contains a duplicate player',
    );
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('preserves an expanded-request failure without saving the partial ranking', async () => {
    const error = new Error('API unavailable');
    mocks.getCompetitionScorers
      .mockResolvedValueOnce(fullResponse)
      .mockRejectedValueOnce(error);

    await expect(syncCompetitionScorers('PL')).rejects.toBe(error);

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('honors cancellation before writing without exposing its reason', async () => {
    const controller = new AbortController();
    const result = syncCompetitionScorers('PL', { signal: controller.signal });
    controller.abort(new Error('Sensitive abort reason'));

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data scorers sync aborted',
    });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('reports a failed write without exposing driver details or retrying it', async () => {
    mocks.batch.mockRejectedValue(new Error('Sensitive database connection'));

    const result = syncCompetitionScorers('PL');

    await expect(result).rejects.toThrow('competition scorers could not be saved');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
});
