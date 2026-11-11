import 'server-only';

import { asc, eq } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { squadPlayers } from '../db/schema';

/** Current squad only. Birth dates are calendar-date strings. */
export async function getTeamSquad(teamId: number) {
  'use cache';

  cacheLife('hours');
  cacheTag(footballCacheTags.squads);

  try {
    const players = await db
      .select()
      .from(squadPlayers)
      .where(eq(squadPlayers.teamId, teamId))
      .orderBy(asc(squadPlayers.name), asc(squadPlayers.id));

    return players;
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('team squad could not be loaded');
  }
}
