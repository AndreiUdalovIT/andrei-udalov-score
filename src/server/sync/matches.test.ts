import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import fixture from '@/lib/football-data/fixtures/matches.json';
import { matchSchema } from '@/lib/football-data/schemas/matches';

import { syncCompetitionMatches } from './matches';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  getCompetitionMatches:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetitionMatches']>(),
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<void>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({
    getCompetitionMatches: mocks.getCompetitionMatches,
  }),
}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

const upcoming = matchSchema.parse(fixture.upcoming);
const response = { matches: [upcoming] };

function getQuery(callIndex = 0) {
  const query = mocks.batch.mock.calls[callIndex]?.[0]?.[0];
  if (!query) throw new Error('Missing captured query');
  return query.toSQL();
}

beforeEach(() => {
  mocks.getCompetitionMatches.mockReset().mockResolvedValue(response);
  mocks.batch.mockReset().mockResolvedValue(undefined);
});

describe('competition matches sync', () => {
  it('waits for the filtered API response and upserts by ID with a freshness guard', async () => {
    const pending = Promise.withResolvers<typeof response>();
    mocks.getCompetitionMatches.mockReturnValueOnce(pending.promise);
    const options = {
      season: 2026,
      status: 'TIMED' as const,
      dateFrom: '2026-11-01',
      dateTo: '2026-11-07',
    };

    const result = syncCompetitionMatches('PL', options);
    expect(mocks.batch).not.toHaveBeenCalled();
    pending.resolve(response);

    await expect(result).resolves.toEqual({
      competitionCode: 'PL',
      matchCount: 1,
    });
    expect(mocks.getCompetitionMatches).toHaveBeenCalledWith('PL', options);
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(1);

    const query = getQuery();
    expect(query.sql).toContain('on conflict ("id") do update set');
    expect(query.sql).toContain(
      'where "matches"."last_updated" <= excluded.last_updated',
    );
    const update = query.sql.split('do update set')[1];
    for (const column of [
      'utc_date',
      'status',
      'home_goals',
      'away_goals',
      'home_goals90',
      'away_goals90',
      'home_penalties',
      'away_penalties',
      'last_updated',
    ]) {
      expect(update).toContain(`"${column}" = excluded.${column}`);
    }
  });

  it('sends a new kickoff and explicit null scores when a match is rescheduled', async () => {
    mocks.getCompetitionMatches
      .mockResolvedValueOnce({
        matches: [
          {
            ...upcoming,
            status: 'FINISHED',
            score: {
              ...upcoming.score,
              fullTime: { home: 2, away: 1 },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        matches: [
          {
            ...upcoming,
            status: 'POSTPONED',
            utcDate: '2026-11-13T20:00:00Z',
            lastUpdated: '2026-11-05T12:00:00Z',
          },
        ],
      });

    await syncCompetitionMatches('PL');
    await syncCompetitionMatches('PL');

    expect(getQuery(0).params.slice(9, 13)).toEqual([2, 1, 2, 1]);
    const updated = getQuery(1);
    expect(updated.params[0]).toBe(upcoming.id);
    expect(updated.params[5]).toBe('2026-11-13T20:00:00.000Z');
    expect(updated.params[6]).toBe('POSTPONED');
    expect(updated.params.slice(9, 13)).toEqual([null, null, null, null]);
    expect(updated.params.slice(14, 16)).toEqual([null, null]);
    expect(updated.params[16]).toBe('2026-11-05T12:00:00.000Z');
  });

  it('leaves saved matches untouched when a date window is empty', async () => {
    mocks.getCompetitionMatches.mockResolvedValue({ matches: [] });

    await expect(
      syncCompetitionMatches('PL', {
        dateFrom: '2026-11-01',
        dateTo: '2026-11-07',
      }),
    ).resolves.toEqual({ competitionCode: 'PL', matchCount: 0 });

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('preserves an API failure without starting a database batch', async () => {
    const error = new Error('API unavailable');
    mocks.getCompetitionMatches.mockRejectedValue(error);

    await expect(syncCompetitionMatches('PL')).rejects.toBe(error);

    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('honors cancellation before writing without exposing its reason', async () => {
    const controller = new AbortController();
    const result = syncCompetitionMatches('PL', { signal: controller.signal });
    controller.abort(new Error('Sensitive abort reason'));

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data match sync aborted',
    });
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('reports a failed write without exposing driver details or retrying it', async () => {
    mocks.batch.mockRejectedValue(new Error('Sensitive database connection'));

    const result = syncCompetitionMatches('PL');

    await expect(result).rejects.toThrow('competition matches could not be saved');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
});
