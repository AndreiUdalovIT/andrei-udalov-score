import 'server-only';

import { and, arrayContains, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { syncRuns, type SyncMode } from '../db/schema';

const runFields = {
  id: syncRuns.id,
  mode: syncRuns.mode,
  status: syncRuns.status,
  startedAt: syncRuns.startedAt,
  finishedAt: syncRuns.finishedAt,
};

/**
 * Run-level status, not the freshness of a particular season or dataset.
 * Use full/seed modes for squads; light sync does not update them.
 */
export async function getCompetitionSyncStatus(
  competitionCode: CompetitionCode,
  modes: readonly SyncMode[] = ['light', 'full', 'seed'],
) {
  try {
    const scope = and(
      arrayContains(syncRuns.competitionCodes, [competitionCode]),
      inArray(syncRuns.mode, modes),
    );

    const [[latestRun], [lastSuccessfulRun]] = await db.batch([
      db
        .select(runFields)
        .from(syncRuns)
        .where(scope)
        .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
        .limit(1),
      db
        .select(runFields)
        .from(syncRuns)
        .where(and(scope, eq(syncRuns.status, 'ok'), isNotNull(syncRuns.finishedAt)))
        .orderBy(desc(syncRuns.finishedAt), desc(syncRuns.id))
        .limit(1),
    ]);

    return {
      latestRun: latestRun ?? null,
      lastSuccessfulRun: lastSuccessfulRun ?? null,
    };
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition sync status could not be loaded');
  }
}
