import 'server-only';

import { sql } from 'drizzle-orm';

import { createFootballDataApi } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';
import { mapMatch } from '@/lib/football-data/mappers/matches';
import type { MatchStatus } from '@/lib/types/football';

import { db } from '../db/client';
import { matches } from '../db/schema';

type MatchesSyncOptions = {
  season?: number;
  status?: MatchStatus;
  dateFrom?: string;
  dateTo?: string;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

// Sync the competition and its season's teams before saving their matches.
export async function syncCompetitionMatches(
  competitionCode: string,
  { requestCounter, ...options }: MatchesSyncOptions = {},
) {
  const api = createFootballDataApi({ requestCounter });
  const response = await api.getCompetitionMatches(competitionCode, options);
  if (options.signal?.aborted) {
    throw new DOMException('football-data match sync aborted', 'AbortError');
  }

  const result = {
    competitionCode: competitionCode.trim().toUpperCase(),
    matchCount: response.matches.length,
  };
  // An empty date window must not remove previously saved matches.
  if (response.matches.length === 0) return result;

  const rows = response.matches.map(mapMatch);
  try {
    await db.batch([
      db
        .insert(matches)
        .values(rows)
        .onConflictDoUpdate({
          target: matches.id,
          set: {
            competitionId: sql`excluded.competition_id`,
            season: sql`excluded.season`,
            matchday: sql`excluded.matchday`,
            stage: sql`excluded.stage`,
            utcDate: sql`excluded.utc_date`,
            status: sql`excluded.status`,
            homeTeamId: sql`excluded.home_team_id`,
            awayTeamId: sql`excluded.away_team_id`,
            homeGoals: sql`excluded.home_goals`,
            awayGoals: sql`excluded.away_goals`,
            homeGoals90: sql`excluded.home_goals90`,
            awayGoals90: sql`excluded.away_goals90`,
            duration: sql`excluded.duration`,
            homePenalties: sql`excluded.home_penalties`,
            awayPenalties: sql`excluded.away_penalties`,
            lastUpdated: sql`excluded.last_updated`,
          },
          // Ignore older snapshots; allow corrections with the same timestamp.
          setWhere: sql`${matches.lastUpdated} <= excluded.last_updated`,
        }),
    ]);
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition matches could not be saved');
  }

  return result;
}
