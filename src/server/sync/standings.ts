import 'server-only';

import { and, eq } from 'drizzle-orm';

import { createFootballDataApi, validateSeason } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';
import { mapStandings } from '@/lib/football-data/mappers/standings';

import { db } from '../db/client';
import { standings, standingsSnapshots } from '../db/schema';

type StandingsSyncOptions = {
  season?: number;
  /** Reconstructed history for one round, requiring an explicit season. */
  matchday?: number;
  captureOfficial?: boolean;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

// Sync the competition and its season's teams before saving standings.
export async function syncCompetitionStandings(
  competitionCode: string,
  {
    season,
    matchday,
    captureOfficial = false,
    signal,
    requestCounter,
  }: StandingsSyncOptions = {},
) {
  validateSeason(season);
  if (matchday !== undefined && (season === undefined || captureOfficial)) {
    throw new RangeError(
      'matchday requires season and cannot capture official standings',
    );
  }
  const api = createFootballDataApi({ requestCounter });
  const response = await api.getCompetitionStandings(competitionCode, {
    season: captureOfficial ? undefined : season,
    matchday,
    signal,
  });
  const capturedAt = new Date();
  if (signal?.aborted) {
    throw new DOMException('football-data standings sync aborted', 'AbortError');
  }

  const seasonYear = Number(response.season.startDate.slice(0, 4));
  if (season !== undefined && seasonYear !== season) {
    throw new Error('competition season changed during standings sync');
  }
  const rows = mapStandings(response);
  if (matchday !== undefined && rows.length === 0) {
    throw new Error('standings history response has no TOTAL rows');
  }
  const competitionId = response.competition.id;

  try {
    const removePrevious = db
      .delete(standings)
      .where(
        and(
          eq(standings.competitionId, competitionId),
          eq(standings.season, seasonYear),
        ),
      );
    const insertRows = rows.length === 0 ? [] : [db.insert(standings).values(rows)];
    const capture = db.insert(standingsSnapshots).values({
      competitionId,
      season: seasonYear,
      source: matchday === undefined ? 'official' : 'reconstructed',
      matchday: matchday ?? response.season.currentMatchday,
      capturedAt,
      rows: rows.map((row) => ({
        teamId: row.teamId,
        stage: row.stage,
        group: row.group,
        position: row.position,
        playedGames: row.playedGames,
        won: row.won,
        draw: row.draw,
        lost: row.lost,
        points: row.points,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
      })),
    });
    // Round history is appended independently of the current table.
    await db.batch(
      matchday === undefined
        ? [removePrevious, ...insertRows, ...(captureOfficial ? [capture] : [])]
        : [capture],
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
