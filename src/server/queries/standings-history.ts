import 'server-only';

import { and, asc, desc, eq, getTableColumns } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { CompetitionCode } from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import {
  competitions,
  standingsSnapshots,
  type StandingsSnapshotSource,
} from '../db/schema';

/** Latest observations for one source, with coverage inside the captured range. */
export async function getCompetitionStandingsHistory(
  competitionCode: CompetitionCode,
  season: number,
  source: StandingsSnapshotSource,
) {
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.competition(competitionCode),
    footballCacheTags.season(competitionCode, season),
  );

  try {
    const rows = await db
      .selectDistinctOn(
        [standingsSnapshots.matchday],
        getTableColumns(standingsSnapshots),
      )
      .from(standingsSnapshots)
      .innerJoin(competitions, eq(standingsSnapshots.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.code, competitionCode),
          eq(standingsSnapshots.season, season),
          eq(standingsSnapshots.source, source),
        ),
      )
      .orderBy(
        asc(standingsSnapshots.matchday),
        desc(standingsSnapshots.capturedAt),
        desc(standingsSnapshots.id),
      );

    const config = getCompetitionSeasonConfig(competitionCode, season);
    const snapshots = rows.map((snapshot) => ({
      ...snapshot,
      tableComplete: config
        ? snapshot.rows.length === config.teamCount &&
          new Set(snapshot.rows.map((row) => row.teamId)).size ===
            config.teamCount &&
          snapshot.rows.every((row) => row.stage === config.mainStage)
        : null,
    }));
    if (config === undefined) return { source, snapshots, coverage: null };

    const rounds = snapshots.flatMap(({ matchday, tableComplete }) =>
      matchday !== null && matchday >= 1 && matchday <= config.matchdays
        ? [{ matchday, tableComplete }]
        : [],
    );
    const availableMatchdays = rounds
      .filter((round) => round.tableComplete)
      .map((round) => round.matchday);
    const available = new Set(availableMatchdays);
    const throughMatchday = Math.max(0, ...rounds.map((round) => round.matchday));

    return {
      source,
      snapshots,
      coverage: {
        seasonMatchdays: config.matchdays,
        throughMatchday,
        availableMatchdays,
        missingMatchdays: Array.from(
          { length: throughMatchday },
          (_, index) => index + 1,
        ).filter((matchday) => !available.has(matchday)),
      },
    };
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('competition standings history could not be loaded');
  }
}
