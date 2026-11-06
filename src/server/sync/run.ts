import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import type { ClientOptions } from '@/lib/football-data/client';

import { db } from '../db/client';
import { syncRuns, type SyncMode, type SyncStatus } from '../db/schema';

import { parseCompetitionOptions } from './command-options';

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super('another sync run is already running');
    this.name = 'SyncAlreadyRunningError';
  }
}

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
  competitionCodes: readonly string[],
  task: (requestCounter: NonNullable<ClientOptions['requestCounter']>) => Promise<T>,
) {
  if (competitionCodes.length === 0) {
    throw new Error('At least one competition is required');
  }
  const codes = [
    ...new Set(
      competitionCodes.map(
        (competition) => parseCompetitionOptions({ competition }).competitionCode,
      ),
    ),
  ].sort();

  let runId: number | undefined;
  try {
    // Serialize the check and insert, then release the table lock before API work.
    const [, , started] = await db.batch([
      db.execute(sql`set transaction isolation level read committed`),
      db.execute(sql`lock table ${syncRuns} in share row exclusive mode`),
      db.execute<{ id: number }>(sql`
        insert into ${syncRuns} ("mode", "status", "competition_codes")
        select ${mode}, 'running', ${sql.param(codes, syncRuns.competitionCodes)}::text[]
        where not exists (
          select 1 from ${syncRuns} where ${syncRuns.status} = 'running'
        )
        returning ${syncRuns.id}
      `),
    ]);
    runId = started.rows[0]?.id;
  } catch {
    throw new Error('sync run could not be started');
  }
  if (runId === undefined) throw new SyncAlreadyRunningError();

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
