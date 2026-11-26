import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { cacheLife, cacheTag } from 'next/cache';

import type { SiteCompetitionCode } from '@/lib/config/competitions';

import { footballCacheTags } from '../cache-tags';
import { db } from '../db/client';
import { competitions, seasonForecasts } from '../db/schema';
import { getCompetitionSeasons } from './competitions';
import { getCompetitionTeams } from './teams';

async function getLatestSeasonForecast(code: SiteCompetitionCode, season: number) {
  'use cache';

  cacheLife('minutes');
  cacheTag(
    footballCacheTags.competition(code),
    footballCacheTags.season(code, season),
  );

  try {
    const [row] = await db
      .select({ id: seasonForecasts.id, forecast: seasonForecasts.forecast })
      .from(seasonForecasts)
      .innerJoin(competitions, eq(seasonForecasts.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.code, code),
          eq(seasonForecasts.season, season),
          eq(
            seasonForecasts.kind,
            code === 'CL' ? 'champions-league-stages' : 'league-table',
          ),
        ),
      )
      .orderBy(
        desc(seasonForecasts.dataCutoff),
        desc(seasonForecasts.calculatedAt),
        desc(seasonForecasts.id),
      )
      .limit(1);

    return row ?? null;
  } catch {
    throw new Error('season forecast could not be loaded');
  }
}

export async function getCurrentSeasonForecast(code: SiteCompetitionCode) {
  const [season] = await getCompetitionSeasons(code);
  if (season === undefined) return null;

  const archived = await getLatestSeasonForecast(code, season);
  if (archived === null) return null;

  const teams = await getCompetitionTeams(code, season);
  return {
    ...archived,
    teamNames: Object.fromEntries(teams.map(({ id, shortName }) => [id, shortName])),
  };
}
