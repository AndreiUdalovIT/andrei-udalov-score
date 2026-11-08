import 'server-only';

import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { CompetitionCode } from '@/lib/config/competitions';

import { db } from '../db/client';
import { competitions, matches, teams } from '../db/schema';

const homeTeam = alias(teams, 'home_team');
const awayTeam = alias(teams, 'away_team');

function selectMatches() {
  // Keep matches even when a knockout opponent is not known yet.
  return db
    .select({
      ...getTableColumns(matches),
      competition: {
        code: competitions.code,
        name: competitions.name,
        emblem: competitions.emblem,
      },
      homeTeam: getTableColumns(homeTeam),
      awayTeam: getTableColumns(awayTeam),
    })
    .from(matches)
    .innerJoin(competitions, eq(matches.competitionId, competitions.id))
    .leftJoin(homeTeam, eq(matches.homeTeamId, homeTeam.id))
    .leftJoin(awayTeam, eq(matches.awayTeamId, awayTeam.id));
}

export async function getMatch(matchId: number) {
  try {
    const [match] = await selectMatches().where(eq(matches.id, matchId)).limit(1);

    return match ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('match could not be loaded');
  }
}

export async function getCompetitionMatches(
  competitionCode: CompetitionCode,
  season: number,
) {
  try {
    const rows = await selectMatches()
      .where(and(eq(competitions.code, competitionCode), eq(matches.season, season)))
      .orderBy(asc(matches.utcDate), asc(matches.id));

    return rows;
  } catch {
    throw new Error('competition matches could not be loaded');
  }
}
