import 'server-only';

import { and, asc, desc, eq, getTableColumns } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import type { CompetitionCode } from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, scorers, teams } from '../db/schema';

export async function getCompetitionScorers(
  competitionCode: CompetitionCode,
  season: number,
) {
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.teams,
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
  );

  try {
    // Season totals also include players who have left the current squad.
    const rows = await db
      .select({
        ...getTableColumns(scorers),
        team: getTableColumns(teams),
      })
      .from(scorers)
      .innerJoin(competitions, eq(scorers.competitionId, competitions.id))
      .innerJoin(teams, eq(scorers.teamId, teams.id))
      .where(and(eq(competitions.code, competitionCode), eq(scorers.season, season)))
      .orderBy(desc(scorers.goals), asc(scorers.playerName), asc(scorers.playerId));

    return rows;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition scorers could not be loaded');
  }
}
