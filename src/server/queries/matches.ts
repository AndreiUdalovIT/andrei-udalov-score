import 'server-only';

import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { cacheLife, cacheTag } from 'next/cache';

import type { CompetitionCode } from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
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
  'use cache';

  cacheLife('minutes');
  cacheTag(footballCacheTags.matches, footballCacheTags.teams);

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
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.teams,
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
  );

  try {
    const rows = await selectMatches()
      .where(and(eq(competitions.code, competitionCode), eq(matches.season, season)))
      .orderBy(asc(matches.utcDate), asc(matches.id));

    return rows;
  } catch {
    throw new Error('competition matches could not be loaded');
  }
}
