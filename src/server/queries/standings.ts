import 'server-only';

import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';

import type { CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { competitions, standings, teams } from '../db/schema';

export async function getCompetitionStandings(
  competitionCode: CompetitionCode,
  season: number,
) {
  try {
    const rows = await db
      .select({
        ...getTableColumns(standings),
        goalDifference: sql<number>`${standings.goalsFor} - ${standings.goalsAgainst}`,
        team: getTableColumns(teams),
      })
      .from(standings)
      .innerJoin(competitions, eq(standings.competitionId, competitions.id))
      .innerJoin(teams, eq(standings.teamId, teams.id))
      .where(
        and(eq(competitions.code, competitionCode), eq(standings.season, season)),
      )
      .orderBy(
        asc(standings.stage),
        asc(standings.group),
        asc(standings.position),
        asc(standings.teamId),
      );

    return rows;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition standings could not be loaded');
  }
}
