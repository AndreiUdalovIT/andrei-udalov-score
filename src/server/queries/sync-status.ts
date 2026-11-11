import 'server-only';

import {
  and,
  arrayContains,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  sql,
} from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import {
  siteCompetitionCodes,
  type CompetitionCode,
} from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
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

/**
 * Run-level timestamp for all site competitions, based on the oldest
 * per-competition successful finish. Null means incomplete journal coverage.
 * It does not describe a specific season or squad snapshot.
 */
export async function getSiteLastSyncedAt() {
  'use cache';

  cacheLife('minutes');
  cacheTag(...siteCompetitionCodes.map(footballCacheTags.competition));

  try {
    const rows = await db
      .select({ finishedAt: max(syncRuns.finishedAt) })
      .from(
        sql`unnest(${sql.param(siteCompetitionCodes, syncRuns.competitionCodes)}::text[]) as requested(code)`,
      )
      .leftJoin(
        syncRuns,
        and(
          arrayContains(syncRuns.competitionCodes, sql`array[requested.code]`),
          eq(syncRuns.status, 'ok'),
          inArray(syncRuns.mode, ['light', 'full', 'seed']),
          isNotNull(syncRuns.finishedAt),
        ),
      )
      .groupBy(sql`requested.code`);

    if (rows.length !== siteCompetitionCodes.length) return null;

    let lastSyncedAt: Date | null = null;
    for (const row of rows) {
      if (!row.finishedAt) return null;
      if (!lastSyncedAt || row.finishedAt < lastSyncedAt) {
        lastSyncedAt = row.finishedAt;
      }
    }

    return lastSyncedAt;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('site sync time could not be loaded');
  }
}
