import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/competition-teams.json';
import { teamsResponseSchema } from '@/lib/football-data/schemas/teams';

import { syncCompetitionTeams } from './teams';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  getCompetitionTeams:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetitionTeams']>(),
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<void>>(),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getCompetitionTeams: mocks.getCompetitionTeams,
  }),
}));

vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

const response = teamsResponseSchema.parse(fixture);

function getQueries() {
  const queries = mocks.batch.mock.calls[0]?.[0];
  if (!queries) throw new Error('Missing captured batch');
  return queries.map((query) => query.toSQL());
}

beforeEach(() => {
  mocks.getCompetitionTeams.mockReset().mockResolvedValue(response);
  mocks.batch.mockReset().mockResolvedValue(undefined);
});

describe('competition teams sync', () => {
  it('waits for API data and submits a scoped current snapshot in one batch', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getCompetitionTeams.mockReturnValueOnce(pending.promise);

    const result = syncCompetitionTeams('PL');
    expect(mocks.batch).not.toHaveBeenCalled();
    pending.resolve(response);

    await expect(result).resolves.toEqual({
      competitionCode: 'PL',
      season: 2026,
      teamCount: 1,
      teamIds: [57],
    });
    expect(mocks.getCompetitionTeams).toHaveBeenCalledWith('PL', {
      season: undefined,
      signal: undefined,
    });
    expect(mocks.batch).toHaveBeenCalledOnce();

    const queries = getQueries();
    expect(queries).toHaveLength(4);
    expect(queries[0]?.sql).toContain('on conflict ("id") do update set');
    expect(queries[0]?.sql.split('do update set')[1]).toContain(
      '"current_matchday"',
    );
    expect(queries[1]?.sql).toContain('on conflict ("id") do update set');
    expect(queries[1]?.sql).toContain('"short_name" = excluded.short_name');
    expect(queries[1]?.sql).toContain('"club_colors" = excluded.club_colors');
    expect(queries[2]?.sql).toContain('"team_competitions"."competition_id" = $1');
    expect(queries[2]?.sql).toContain('"team_competitions"."season" = $2');
    expect(queries[2]?.params).toEqual([2021, 2026]);
    expect(queries[3]?.params).toEqual([2021, 2026, 57]);
  });

  it('replaces only the historical membership and preserves the current matchday', async () => {
    mocks.getCompetitionTeams.mockResolvedValue({
      ...response,
      season: {
        ...response.season,
        startDate: '2024-08-16',
        endDate: '2025-05-25',
        currentMatchday: 38,
      },
    });

    await syncCompetitionTeams('PL', { season: 2024 });

    const queries = getQueries();
    expect(queries[0]?.sql.split('do update set')[1]).not.toContain(
      '"current_matchday"',
    );
    expect(queries[2]?.params).toEqual([2021, 2024]);
    expect(queries[3]?.params).toEqual([2021, 2024, 57]);
  });

  it('preserves an API failure without starting a database batch', async () => {
    const error = new Error('API unavailable');
    mocks.getCompetitionTeams.mockRejectedValue(error);

    await expect(syncCompetitionTeams('PL')).rejects.toBe(error);

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('rejects an empty snapshot before replacing existing membership', async () => {
    mocks.getCompetitionTeams.mockResolvedValue({ ...response, teams: [] });

    await expect(syncCompetitionTeams('PL')).rejects.toThrow(
      'football-data returned no competition teams',
    );

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('honors cancellation before writing without exposing its reason', async () => {
    const controller = new AbortController();
    const result = syncCompetitionTeams('PL', { signal: controller.signal });
    controller.abort(new Error('Sensitive abort reason'));

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data team sync aborted',
    });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('reports a failed write without exposing driver details or retrying it', async () => {
    mocks.batch.mockRejectedValue(new Error('Sensitive database connection'));

    const result = syncCompetitionTeams('PL');

    await expect(result).rejects.toThrow('competition teams could not be saved');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
});
