import 'server-only';

import { and, asc, eq } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import type { CompetitionCode } from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, teamCompetitions, teams } from '../db/schema';

const teamFields = {
  id: teams.id,
  name: teams.name,
  shortName: teams.shortName,
  tla: teams.tla,
  crest: teams.crest,
  clubColors: teams.clubColors,
};

export async function getTeam(teamId: number) {
  'use cache';

  cacheLife('hours');
  cacheTag(footballCacheTags.teams);

  try {
    const [team] = await db
      .select(teamFields)
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    return team ?? null;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('team could not be loaded');
  }
}

export async function getCompetitionTeams(
  competitionCode: CompetitionCode,
  season: number,
) {
  'use cache';

  cacheLife('hours');
  cacheTag(
    footballCacheTags.teams,
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
  );

  try {
    const rows = await db
      .select(teamFields)
      .from(teamCompetitions)
      .innerJoin(teams, eq(teamCompetitions.teamId, teams.id))
      .innerJoin(competitions, eq(teamCompetitions.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.code, competitionCode),
          eq(teamCompetitions.season, season),
        ),
      )
      .orderBy(asc(teams.shortName), asc(teams.id));

    return rows;
  } catch {
    throw new Error('competition teams could not be loaded');
  }
}
