import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { createFootballDataApi } from '@/lib/football-data/api';
import type { ClientOptions } from '@/lib/football-data/client';
import { mapSquad } from '@/lib/football-data/mappers/squad';

import { db } from '../db/client';
import { squadPlayers, teams } from '../db/schema';

type SquadSyncOptions = {
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

export async function syncTeamSquad(
  teamId: number,
  { signal, requestCounter }: SquadSyncOptions = {},
) {
  const api = createFootballDataApi({ requestCounter });
  const response = await api.getTeamSquad(teamId, { signal });
  if (signal?.aborted) {
    throw new DOMException('football-data squad sync aborted', 'AbortError');
  }

  const { team, squadPlayers: players } = mapSquad(response);
  const { id, ...teamUpdate } = team;

  try {
    const saveTeam = db.insert(teams).values(team).onConflictDoUpdate({
      target: teams.id,
      set: teamUpdate,
    });
    const removePrevious = db
      .delete(squadPlayers)
      .where(eq(squadPlayers.teamId, id));

    // Replace this team's snapshot and move incoming players by their global ID.
    await db.batch(
      players.length === 0
        ? [saveTeam, removePrevious]
        : [
            saveTeam,
            removePrevious,
            db
              .insert(squadPlayers)
              .values(players)
              .onConflictDoUpdate({
                target: squadPlayers.id,
                set: {
                  teamId: sql`excluded.team_id`,
                  name: sql`excluded.name`,
                  position: sql`excluded.position`,
                  dateOfBirth: sql`excluded.date_of_birth`,
                  nationality: sql`excluded.nationality`,
                },
              }),
          ],
    );
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('team squad could not be saved');
  }

  return {
    teamId: id,
    playerCount: players.length,
  };
}
