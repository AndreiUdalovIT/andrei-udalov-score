import 'server-only';

import { and, eq } from 'drizzle-orm';

import { createFootballDataApi, validateSeason } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';
import { mapStandings } from '@/lib/football-data/mappers/standings';

import { db } from '../db/client';
import { standings, standingsSnapshots } from '../db/schema';

type StandingsSyncOptions = {
  season?: number;
  captureOfficial?: boolean;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

// Sync the competition and its season's teams before saving standings.
export async function syncCompetitionStandings(
  competitionCode: string,
  {
    season,
    captureOfficial = false,
    signal,
    requestCounter,
  }: StandingsSyncOptions = {},
) {
  validateSeason(season);
  const api = createFootballDataApi({ requestCounter });
  const response = await api.getCompetitionStandings(competitionCode, {
    season: captureOfficial ? undefined : season,
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
    const captures = captureOfficial
      ? [
          db.insert(standingsSnapshots).values({
            competitionId,
            season: seasonYear,
            source: 'official',
            matchday: response.season.currentMatchday,
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
          }),
        ]
      : [];
    // Keep the replacement and any official capture in one transaction.
    await db.batch([removePrevious, ...insertRows, ...captures]);
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
