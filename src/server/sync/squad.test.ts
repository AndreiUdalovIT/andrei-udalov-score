import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/squad.json';
import { squadResponseSchema } from '@/lib/football-data/schemas/squad';

import { syncTeamSquad } from './squad';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  getTeamSquad: vi.fn<ReturnType<typeof createFootballDataApi>['getTeamSquad']>(),
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<void>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getTeamSquad: mocks.getTeamSquad,
  }),
}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

const response = squadResponseSchema.parse(fixture.arsenal);

function getQueries() {
  const queries = mocks.batch.mock.calls[0]?.[0];
  if (!queries) throw new Error('Missing captured batch');
  return queries.map((query) => query.toSQL());
}

beforeEach(() => {
  mocks.getTeamSquad.mockReset().mockResolvedValue(response);
  mocks.batch.mockReset().mockResolvedValue(undefined);
});

describe('team squad sync', () => {
  it('batches a team-scoped replacement with upserts after the API resolves', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getTeamSquad.mockReturnValueOnce(pending.promise);

    const result = syncTeamSquad(57);
    expect(mocks.batch).not.toHaveBeenCalled();
    pending.resolve(response);

    await expect(result).resolves.toEqual({ teamId: 57, playerCount: 2 });
    expect(mocks.getTeamSquad).toHaveBeenCalledExactlyOnceWith(57, {
      signal: undefined,
    });
    expect(mocks.batch).toHaveBeenCalledOnce();

    const queries = getQueries();
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain('insert into "teams"');
    expect(queries[0]?.sql).toContain('on conflict ("id") do update set');
    expect(queries[0]?.params[0]).toBe(57);
    expect(queries[1]?.sql).toContain(
      'delete from "squad_players" where "squad_players"."team_id" = $1',
    );
    expect(queries[1]?.params).toEqual([57]);
    expect(queries[2]?.sql).toContain('on conflict ("id") do update set');
    expect(queries[2]?.params.slice(0, 2)).toEqual([3189, 57]);
    expect(queries[2]?.params.slice(6, 8)).toEqual([302255, 57]);
    for (const column of [
      'team_id',
      'name',
      'position',
      'date_of_birth',
      'nationality',
    ]) {
      expect(queries[2]?.sql).toContain(`"${column}" = excluded.${column}`);
    }
  });

  it('clears an empty squad only for the requested team', async () => {
    mocks.getTeamSquad.mockResolvedValueOnce(
      squadResponseSchema.parse({ ...fixture.clubBrugge, squad: [] }),
    );

    await expect(syncTeamSquad(851)).resolves.toEqual({
      teamId: 851,
      playerCount: 0,
    });

    expect(mocks.batch).toHaveBeenCalledOnce();
    const queries = getQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.params[0]).toBe(851);
    expect(queries[1]?.params).toEqual([851]);
  });

  it('preserves an API failure before starting a database batch', async () => {
    const error = new Error('API unavailable');
    mocks.getTeamSquad.mockRejectedValueOnce(error);

    await expect(syncTeamSquad(57)).rejects.toBe(error);

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('honors cancellation before writing without exposing its reason', async () => {
    const controller = new AbortController();
    const result = syncTeamSquad(57, { signal: controller.signal });
    controller.abort(new Error('Sensitive abort reason'));

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data squad sync aborted',
    });
    expect(mocks.getTeamSquad).toHaveBeenCalledExactlyOnceWith(57, {
      signal: controller.signal,
    });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('reports a failed write without exposing driver details or retrying it', async () => {
    mocks.batch.mockRejectedValueOnce(new Error('Sensitive database connection'));

    const result = syncTeamSquad(57);

    await expect(result).rejects.toThrow('team squad could not be saved');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
});
