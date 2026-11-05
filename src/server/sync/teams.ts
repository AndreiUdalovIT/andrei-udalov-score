import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { createFootballDataApi } from '@/lib/football-data/api';
import { mapCompetitionTeams } from '@/lib/football-data/mappers/teams';

import { db } from '../db/client';
import { competitions, teamCompetitions, teams } from '../db/schema';

type TeamsSyncOptions = {
  season?: number;
  signal?: AbortSignal;
};

export async function syncCompetitionTeams(
  competitionCode: string,
  { season, signal }: TeamsSyncOptions = {},
) {
  const api = createFootballDataApi();
  const response = await api.getCompetitionTeams(competitionCode, {
    season,
    signal,
  });
  if (signal?.aborted) {
    throw new DOMException('football-data team sync aborted', 'AbortError');
  }
  if (response.teams.length === 0) {
    throw new Error('football-data returned no competition teams');
  }

  const rows = mapCompetitionTeams(response, {
    isCurrentSeason: season === undefined,
  });
  const seasonYear = Number(response.season.startDate.slice(0, 4));
  const { id, ...competitionUpdate } = rows.competition;

  try {
    // All API work is complete before opening this short transaction.
    await db.batch([
      db.insert(competitions).values(rows.competition).onConflictDoUpdate({
        target: competitions.id,
        set: competitionUpdate,
      }),
      db
        .insert(teams)
        .values(rows.teams)
        .onConflictDoUpdate({
          target: teams.id,
          set: {
            name: sql`excluded.name`,
            shortName: sql`excluded.short_name`,
            tla: sql`excluded.tla`,
            crest: sql`excluded.crest`,
            clubColors: sql`excluded.club_colors`,
          },
        }),
      db
        .delete(teamCompetitions)
        .where(
          and(
            eq(teamCompetitions.competitionId, id),
            eq(teamCompetitions.season, seasonYear),
          ),
        ),
      db.insert(teamCompetitions).values(rows.teamCompetitions),
    ]);
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition teams could not be saved');
  }

  return {
    competitionCode: rows.competition.code,
    season: seasonYear,
    teamCount: rows.teams.length,
    teamIds: rows.teams.map((team) => team.id),
  };
}
