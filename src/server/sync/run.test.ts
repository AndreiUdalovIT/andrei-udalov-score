import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync, SyncAlreadyRunningError } from './run';

const mocks = vi.hoisted(() => ({
  batch: vi.fn<(queries: readonly SQLWrapper[]) => Promise<unknown[]>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

function getQuery(callIndex: number, queryIndex = 0) {
  const query = mocks.batch.mock.calls[callIndex]?.[0][queryIndex];
  if (!query) throw new Error('Missing captured query');
  return new PgDialect({ casing: 'snake_case' }).sqlToQuery(query.getSQL());
}

const startedRun = [{ rows: [] }, { rows: [] }, { rows: [{ id: 42 }] }];

beforeEach(() => {
  mocks.batch
    .mockReset()
    .mockImplementation(async (queries) =>
      queries.length === 3 ? startedRun : [[{ id: 42 }]],
    );
});

describe('sync run journal', () => {
  it('starts a running record before the task and saves success with its request count', async () => {
    const value = { squadCount: 20 };
    const codes = [' pl ', 'CL', 'PL'];
    const result = await runSync('full', codes, async (requestCounter) => {
      expect(mocks.batch).toHaveBeenCalledOnce();
      expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(3);
      expect(getQuery(0).sql).toBe('set transaction isolation level read committed');
      expect(getQuery(0, 1).sql).toBe(
        'lock table "sync_runs" in share row exclusive mode',
      );
      const startQuery = getQuery(0, 2);
      expect(startQuery.sql).toContain('where not exists (');
      expect(startQuery.sql).toContain(`where "sync_runs"."status" = 'running'`);
      expect(startQuery.params).toEqual(['full', '{"CL","PL"}']);
      expect(requestCounter.count).toBe(0);
      requestCounter.count = 3;
      return value;
    });

    expect(result).toBe(value);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    const query = getQuery(1);
    expect(query.sql).toContain('"finished_at" = now()');
    expect(query.sql).toContain(
      'where ("sync_runs"."id" = $4 and "sync_runs"."status" = $5)',
    );
    expect(query.params).toEqual(['ok', 3, null, 42, 'running']);
  });

  it('records a failed task and its request count without storing error details', async () => {
    const error = new Error('Sensitive connection details');

    await expect(
      runSync('full', ['PL'], async (requestCounter) => {
        requestCounter.count = 4;
        throw error;
      }),
    ).rejects.toBe(error);

    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(getQuery(1).params).toEqual([
      'error',
      4,
      'sync operation failed',
      42,
      'running',
    ]);
  });

  it('rejects another mode before calling its task when a run is active', async () => {
    mocks.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const task = vi.fn(async () => undefined);

    await expect(runSync('light', ['CL'], task)).rejects.toBeInstanceOf(
      SyncAlreadyRunningError,
    );

    expect(task).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(getQuery(0, 2).params).toEqual(['light', '{"CL"}']);
  });

  it.each([{ codes: [] }, { codes: ['PL', '../CL'] }])(
    'rejects an invalid scope $codes before starting a run',
    async ({ codes }) => {
      const task = vi.fn(async () => undefined);

      await expect(runSync('full', codes, task)).rejects.toThrow();

      expect(task).not.toHaveBeenCalled();
      expect(mocks.batch).not.toHaveBeenCalled();
    },
  );

  it('stops before calling the task when the running record cannot be saved', async () => {
    mocks.batch.mockRejectedValueOnce(new Error('Sensitive database details'));
    const task = vi.fn(async () => undefined);
    const result = runSync('full', ['PL'], task);

    await expect(result).rejects.toThrow('sync run could not be started');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(task).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledOnce();
  });

  it.each(['write error', 'missing run'])(
    'reports an unsuccessful finalization caused by %s',
    async (scenario) => {
      mocks.batch.mockResolvedValueOnce(startedRun);
      if (scenario === 'write error') {
        mocks.batch.mockRejectedValueOnce(new Error('Sensitive database details'));
      } else {
        mocks.batch.mockResolvedValueOnce([[]]);
      }
      const task = vi.fn(async (requestCounter: { count: number }) => {
        requestCounter.count = 2;
        return 'saved';
      });
      const result = runSync('full', ['PL'], task);

      await expect(result).rejects.toThrow('sync run status could not be saved');
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(task).toHaveBeenCalledOnce();
      expect(mocks.batch).toHaveBeenCalledTimes(2);
    },
  );
});
