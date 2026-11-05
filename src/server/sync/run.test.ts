import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from './run';

type BatchQuery = {
  toSQL(): { sql: string; params: unknown[] };
};

const mocks = vi.hoisted(() => ({
  batch: vi.fn<(queries: readonly BatchQuery[]) => Promise<{ id: number }[][]>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', { value: mocks.batch });
  return { db: database };
});

function getQuery(callIndex: number) {
  const query = mocks.batch.mock.calls[callIndex]?.[0][0];
  if (!query) throw new Error('Missing captured query');
  return query.toSQL();
}

beforeEach(() => {
  mocks.batch.mockReset().mockResolvedValue([[{ id: 42 }]]);
});

describe('sync run journal', () => {
  it('starts a running record before the task and saves success with its request count', async () => {
    const value = { squadCount: 20 };
    const result = await runSync('full', async (requestCounter) => {
      expect(mocks.batch).toHaveBeenCalledOnce();
      expect(getQuery(0).params).toEqual(['full', 'running']);
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
      runSync('full', async (requestCounter) => {
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

  it('stops before calling the task when the running record cannot be saved', async () => {
    mocks.batch.mockRejectedValueOnce(new Error('Sensitive database details'));
    const task = vi.fn(async () => undefined);
    const result = runSync('full', task);

    await expect(result).rejects.toThrow('sync run could not be started');
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(task).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledOnce();
  });

  it.each(['write error', 'missing run'])(
    'reports an unsuccessful finalization caused by %s',
    async (scenario) => {
      mocks.batch.mockResolvedValueOnce([[{ id: 42 }]]);
      if (scenario === 'write error') {
        mocks.batch.mockRejectedValueOnce(new Error('Sensitive database details'));
      } else {
        mocks.batch.mockResolvedValueOnce([[]]);
      }
      const task = vi.fn(async (requestCounter: { count: number }) => {
        requestCounter.count = 2;
        return 'saved';
      });
      const result = runSync('full', task);

      await expect(result).rejects.toThrow('sync run status could not be saved');
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(task).toHaveBeenCalledOnce();
      expect(mocks.batch).toHaveBeenCalledTimes(2);
    },
  );
});
