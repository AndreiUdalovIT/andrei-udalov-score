import 'server-only';

import type { scorers } from '@/server/db/schema';

import type { ApiScorersResponse } from '../schemas/scorers';

export function mapScorers({
  competition,
  season,
  scorers: apiScorers,
}: ApiScorersResponse): (typeof scorers.$inferInsert)[] {
  const seasonYear = Number(season.startDate.slice(0, 4));
  const playerIds = new Set<number>();

  return apiScorers.map((scorer) => {
    // The DB stores one row per player in a competition season.
    if (playerIds.has(scorer.player.id)) {
      throw new Error('Scorers response contains a duplicate player');
    }
    playerIds.add(scorer.player.id);

    return {
      competitionId: competition.id,
      season: seasonYear,
      playerId: scorer.player.id,
      playerName: scorer.player.name,
      teamId: scorer.team.id,
      playedMatches: scorer.playedMatches,
      goals: scorer.goals,
      assists: scorer.assists,
      penalties: scorer.penalties,
    };
  });
}
