import 'server-only';

import type { matches } from '@/server/db/schema';

import type { ApiMatch } from '../schemas/matches';

export function mapMatch(match: ApiMatch): typeof matches.$inferInsert {
  const { score } = match;
  // Without regularTime, a 90-minute result is known only after a
  // regular match has finished.
  const regularTime =
    score.regularTime ??
    (match.status === 'FINISHED' && score.duration === 'REGULAR'
      ? score.fullTime
      : { home: null, away: null });

  return {
    id: match.id,
    competitionId: match.competition.id,
    season: Number(match.season.startDate.slice(0, 4)),
    matchday: match.matchday,
    stage: match.stage,
    utcDate: new Date(match.utcDate),
    status: match.status,
    homeTeamId: match.homeTeam.id,
    awayTeamId: match.awayTeam.id,
    // fullTime includes shootout goals; keep the period scores separately.
    homeGoals: score.fullTime.home,
    awayGoals: score.fullTime.away,
    homeGoals90: regularTime.home,
    awayGoals90: regularTime.away,
    duration: score.duration,
    homePenalties: score.penalties?.home ?? null,
    awayPenalties: score.penalties?.away ?? null,
    lastUpdated: new Date(match.lastUpdated),
  };
}
