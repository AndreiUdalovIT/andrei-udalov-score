import 'server-only';

import { and, desc, eq, getTableColumns, inArray, lte, sql } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';
import { z } from 'zod';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { matches, predictions } from '../db/schema';

const predictionLookupSchema = z.object({
  matchId: z.int32(),
  modelVersion: z.string().refine((version) => version.trim().length > 0),
});

export async function getMatchPrediction(matchId: number, modelVersion: string) {
  'use cache';

  cacheLife('minutes');
  cacheTag(footballCacheTags.matches);
  return loadMatchPrediction(matchId, modelVersion);
}

/**
 * Read published forecasts for the current participants and exact kickoff.
 * Prefer the newest input cutoff, then database receipt time and row ID.
 * The database clock limits visibility to publications already received.
 */
export async function loadMatchPrediction(matchId: number, modelVersion: string) {
  const input = predictionLookupSchema.safeParse({ matchId, modelVersion });
  if (!input.success) {
    throw new RangeError('invalid prediction lookup');
  }

  try {
    const [prediction] = await db
      .select(getTableColumns(predictions))
      .from(predictions)
      .innerJoin(matches, eq(predictions.matchId, matches.id))
      .where(
        and(
          eq(predictions.matchId, input.data.matchId),
          eq(predictions.source, 'published'),
          eq(predictions.modelVersion, input.data.modelVersion),
          eq(predictions.homeTeamId, matches.homeTeamId),
          eq(predictions.awayTeamId, matches.awayTeamId),
          eq(predictions.kickoffAt, matches.utcDate),
          inArray(matches.status, [
            'SCHEDULED',
            'TIMED',
            'IN_PLAY',
            'PAUSED',
            'EXTRA_TIME',
            'PENALTY_SHOOTOUT',
            'FINISHED',
            'SUSPENDED',
          ]),
          lte(predictions.publishedAt, sql`now()`),
        ),
      )
      .orderBy(
        desc(predictions.dataCutoff),
        desc(predictions.recordedAt),
        desc(predictions.id),
      )
      .limit(1);

    return prediction ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('match prediction could not be loaded');
  }
}
