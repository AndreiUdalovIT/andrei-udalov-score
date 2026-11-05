import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import type { ClientOptions } from '@/lib/football-data/client';

import { db } from '../db/client';
import { syncRuns, type SyncMode, type SyncStatus } from '../db/schema';

async function finishRun(
  runId: number,
  status: Exclude<SyncStatus, 'running'>,
  requests: number,
) {
  try {
    const [savedRuns] = await db.batch([
      db
        .update(syncRuns)
        .set({
          status,
          finishedAt: sql`now()`,
          requests,
          error: status === 'error' ? 'sync operation failed' : null,
        })
        .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, 'running')))
        .returning({ id: syncRuns.id }),
    ]);
    if (savedRuns.length !== 1) {
      throw new Error('Missing running sync');
    }
  } catch {
    throw new Error('sync run status could not be saved');
  }
}

export async function runSync<T>(
  mode: SyncMode,
  task: (requestCounter: NonNullable<ClientOptions['requestCounter']>) => Promise<T>,
) {
  let runId: number;
  try {
    const [[run]] = await db.batch([
      db
        .insert(syncRuns)
        .values({ mode, status: 'running' })
        .returning({ id: syncRuns.id }),
    ]);
    if (!run) throw new Error('Missing sync run');
    runId = run.id;
  } catch {
    throw new Error('sync run could not be started');
  }

  const requestCounter = { count: 0 };
  let result: T;
  try {
    result = await task(requestCounter);
  } catch (error) {
    await finishRun(runId, 'error', requestCounter.count);
    throw error;
  }

  await finishRun(runId, 'ok', requestCounter.count);
  return result;
}
