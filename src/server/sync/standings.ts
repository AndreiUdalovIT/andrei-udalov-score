import 'server-only';

import { and, eq } from 'drizzle-orm';

import { createFootballDataApi } from '@/lib/football-data/api';
import { mapStandings } from '@/lib/football-data/mappers/standings';

import { db } from '../db/client';
import { standings } from '../db/schema';

type StandingsSyncOptions = {
  season?: number;
  signal?: AbortSignal;
};

// Sync the competition and its season's teams before saving standings.
export async function syncCompetitionStandings(
  competitionCode: string,
  { season, signal }: StandingsSyncOptions = {},
) {
  const api = createFootballDataApi();
  const response = await api.getCompetitionStandings(competitionCode, {
    season,
    signal,
  });
  if (signal?.aborted) {
    throw new DOMException('football-data standings sync aborted', 'AbortError');
  }

  const rows = mapStandings(response);
  const competitionId = response.competition.id;
  const seasonYear = Number(response.season.startDate.slice(0, 4));

  try {
    const removePrevious = db
      .delete(standings)
      .where(
        and(
          eq(standings.competitionId, competitionId),
          eq(standings.season, seasonYear),
        ),
      );
    // Replace the complete season snapshot in one short transaction.
    await db.batch(
      rows.length === 0
        ? [removePrevious]
        : [removePrevious, db.insert(standings).values(rows)],
    );
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition standings could not be saved');
  }

  return {
    competitionCode: response.competition.code,
    season: seasonYear,
    rowCount: rows.length,
  };
}
