import 'server-only';

import { and, asc, desc, eq, getTableColumns, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { competitionConfig, type CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { competitions, matchObservations } from '../db/schema';

const competitionCodes = Object.keys(competitionConfig) as CompetitionCode[];
const observationLookupSchema = z.object({
  competitionCodes: z.array(z.enum(competitionCodes)).min(1),
  seasons: z.array(z.int32()).min(1),
  before: z.date(),
});

/** Latest observed states for one competition strictly before the cutoff. */
export async function loadCompetitionMatchObservations(
  competitionCode: CompetitionCode,
  seasons: readonly number[],
  before: Date,
) {
  const rows = await loadMatchObservations([competitionCode], seasons, before);
  return rows.map((row) => row.observation);
}

/**
 * Read multiple competitions in one SQL snapshot for historical model inputs.
 * Historical scope identifies candidates. The latest state is scoped again
 * so changes of competition or season take effect at their observation time.
 * Complete states retain status, fixture changes and score revisions.
 */
export async function loadMatchObservations(
  competitionCodes: readonly CompetitionCode[],
  seasons: readonly number[],
  before: Date,
) {
  const input = observationLookupSchema.safeParse({
    competitionCodes,
    seasons,
    before,
  });
  if (!input.success) {
    throw new RangeError('invalid match observation lookup');
  }
  const cutoff = new Date(input.data.before.getTime());

  try {
    const competitionIds = db
      .select({ id: competitions.id })
      .from(competitions)
      .where(inArray(competitions.code, input.data.competitionCodes));
    const candidates = db
      .select({ matchId: matchObservations.matchId })
      .from(matchObservations)
      .where(
        and(
          inArray(matchObservations.competitionId, competitionIds),
          inArray(matchObservations.season, input.data.seasons),
          lt(matchObservations.observedAt, cutoff),
        ),
      );
    const latest = db
      .selectDistinctOn([matchObservations.matchId], {
        competitionCode: competitions.code,
        observation: getTableColumns(matchObservations),
      })
      .from(matchObservations)
      .innerJoin(competitions, eq(matchObservations.competitionId, competitions.id))
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
          inArray(latest.competitionCode, input.data.competitionCodes),
          inArray(latest.observation.season, input.data.seasons),
        ),
      )
      .orderBy(asc(latest.observation.utcDate), asc(latest.observation.matchId));
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition match observations could not be loaded');
  }
}
