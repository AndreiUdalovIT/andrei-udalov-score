import 'server-only';

import type { squadPlayers, teams } from '@/server/db/schema';

import type { ApiSquadResponse } from '../schemas/squad';
import { mapTeam } from './teams';

type SquadRows = {
  team: typeof teams.$inferInsert;
  squadPlayers: (typeof squadPlayers.$inferInsert)[];
};

export function mapSquad(response: ApiSquadResponse): SquadRows {
  const playerIds = new Set<number>();

  return {
    team: mapTeam(response),
    squadPlayers: response.squad.map((player) => {
      // A player ID is the primary key of squad_players.
      if (playerIds.has(player.id)) {
        throw new Error('Squad response contains a duplicate player');
      }
      playerIds.add(player.id);

      return {
        id: player.id,
        teamId: response.id,
        name: player.name,
        position: player.position,
        dateOfBirth: player.dateOfBirth,
        nationality: player.nationality,
      };
    }),
  };
}
