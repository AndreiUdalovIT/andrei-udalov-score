import 'server-only';

import { and, eq } from 'drizzle-orm';

import { createFootballDataApi } from '@/lib/football-data/api';
import { mapScorers } from '@/lib/football-data/mappers/scorers';
import type { ApiScorersResponse } from '@/lib/football-data/schemas/scorers';

import { db } from '../db/client';
import { scorers } from '../db/schema';

type ScorersSyncOptions = {
  season?: number;
  signal?: AbortSignal;
};

// Sync the competition and its season's teams before saving scorers.
export async function syncCompetitionScorers(
  competitionCode: string,
  { season, signal }: ScorersSyncOptions = {},
) {
  const api = createFootballDataApi();
  let limit = 1_000;
  let response: ApiScorersResponse;

  // Expand a filled list before replacing the complete saved ranking.
  while (true) {
    response = await api.getCompetitionScorers(competitionCode, {
      season,
      limit,
      signal,
    });
    if (signal?.aborted) {
      throw new DOMException('football-data scorers sync aborted', 'AbortError');
    }
    if (response.scorers.length < limit) break;
    limit *= 2;
  }

  const rows = mapScorers(response);
  const competitionId = response.competition.id;
  const seasonYear = Number(response.season.startDate.slice(0, 4));

  try {
    const removePrevious = db
      .delete(scorers)
      .where(
        and(
          eq(scorers.competitionId, competitionId),
          eq(scorers.season, seasonYear),
        ),
      );
    await db.batch(
      rows.length === 0
        ? [removePrevious]
        : [removePrevious, db.insert(scorers).values(rows)],
    );
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition scorers could not be saved');
  }

  return {
    competitionCode: response.competition.code,
    season: seasonYear,
    rowCount: rows.length,
  };
}
