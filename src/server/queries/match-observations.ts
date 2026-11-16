import 'server-only';

import { and, asc, desc, eq, getTableColumns, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { competitionConfig, type CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { competitions, matchObservations } from '../db/schema';

const competitionCodes = Object.keys(competitionConfig) as CompetitionCode[];
const observationLookupSchema = z.object({
  competitionCode: z.enum(competitionCodes),
  seasons: z.array(z.int32()).min(1),
  before: z.date(),
});

/**
 * Latest observed state of each match strictly before the supplied cutoff.
 * Historical scope identifies candidates. The latest state is scoped again
 * so changes of competition or season take effect at their observation time.
 * Complete states retain status, fixture changes and score revisions.
 */
export async function loadCompetitionMatchObservations(
  competitionCode: CompetitionCode,
  seasons: readonly number[],
  before: Date,
) {
  const input = observationLookupSchema.safeParse({
    competitionCode,
    seasons,
    before,
  });
  if (!input.success) {
    throw new RangeError('invalid match observation lookup');
  }
  const cutoff = new Date(input.data.before.getTime());

  try {
    const competitionId = db
      .select({ id: competitions.id })
      .from(competitions)
      .where(eq(competitions.code, input.data.competitionCode));
    const candidates = db
      .select({ matchId: matchObservations.matchId })
      .from(matchObservations)
      .where(
        and(
          eq(matchObservations.competitionId, competitionId),
          inArray(matchObservations.season, input.data.seasons),
          lt(matchObservations.observedAt, cutoff),
        ),
      );
    const latest = db
      .selectDistinctOn(
        [matchObservations.matchId],
        getTableColumns(matchObservations),
      )
      .from(matchObservations)
      .where(
        and(
          inArray(matchObservations.matchId, candidates),
          lt(matchObservations.observedAt, cutoff),
        ),
      )
      .orderBy(
        asc(matchObservations.matchId),
        desc(matchObservations.observedAt),
        desc(matchObservations.id),
      )
      .as('latest_match_observations');

    return await db
      .select()
      .from(latest)
      .where(
        and(
          eq(latest.competitionId, competitionId),
          inArray(latest.season, input.data.seasons),
        ),
      )
      .orderBy(asc(latest.utcDate), asc(latest.matchId));
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition match observations could not be loaded');
  }
}
