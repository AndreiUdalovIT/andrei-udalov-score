import 'server-only';

import { desc, eq } from 'drizzle-orm';

import type { CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { competitions, teamCompetitions } from '../db/schema';

export async function getCompetition(competitionCode: CompetitionCode) {
  try {
    const [competition] = await db
      .select({
        id: competitions.id,
        code: competitions.code,
        name: competitions.name,
        emblem: competitions.emblem,
        currentMatchday: competitions.currentMatchday,
      })
      .from(competitions)
      .where(eq(competitions.code, competitionCode))
      .limit(1);

    return competition ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition could not be loaded');
  }
}

/** Seasons with stored participants, newest first. */
export async function getCompetitionSeasons(competitionCode: CompetitionCode) {
  try {
    const rows = await db
      .selectDistinct({ season: teamCompetitions.season })
      .from(teamCompetitions)
      .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
      .where(eq(competitions.code, competitionCode))
      .orderBy(desc(teamCompetitions.season));

    return rows.map(({ season }) => season);
  } catch {
    throw new Error('competition seasons could not be loaded');
  }
}
