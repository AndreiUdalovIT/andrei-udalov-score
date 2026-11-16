import 'server-only';

import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm';

import type { CompetitionCode } from '@/lib/config/competitions';
import { predictionModelConfig } from '@/lib/config/model-predictions';
import { strengthModelOptions } from '@/lib/config/model-strengths';
import { calculateExpectedGoals } from '@/lib/model/expected-goals';

import { db } from '../db/client';
import { competitions, matches } from '../db/schema';
import { loadCompetitionStrengths } from '../queries/strengths';
import { publishPrediction } from './publish';

type UpcomingPredictionWindow = {
  dataCutoff: Date;
  until: Date;
  signal?: AbortSignal;
};

async function loadUpcomingFixtures(
  competitionCode: CompetitionCode,
  season: number,
  dataCutoff: Date,
  until: Date,
) {
  try {
    return await db
      .select({
        id: matches.id,
        status: matches.status,
        utcDate: matches.utcDate,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
      })
      .from(matches)
      .innerJoin(competitions, eq(matches.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.code, competitionCode),
          eq(matches.season, season),
          inArray(matches.status, ['SCHEDULED', 'TIMED']),
          gt(matches.utcDate, dataCutoff),
          lt(matches.utcDate, until),
          ne(matches.homeTeamId, matches.awayTeamId),
        ),
      )
      .orderBy(asc(matches.utcDate), asc(matches.id));
  } catch {
    // Driver errors may contain connection details or query parameters.
    throw new Error('upcoming fixtures could not be loaded');
  }
}

/**
 * Use one input cutoff for the supplied competition, season and open window.
 * Reusing that cutoff makes retries preserve already published fixture snapshots.
 * Publication rechecks the fixture and deadline against the current database row.
 */
export async function publishUpcomingPredictions(
  competitionCode: CompetitionCode,
  season: number,
  window: Readonly<UpcomingPredictionWindow>,
) {
  const dataCutoff = new Date(window.dataCutoff.getTime());
  const until = new Date(window.until.getTime());
  const { signal } = window;
  if (
    !Number.isFinite(dataCutoff.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    dataCutoff.getTime() >= until.getTime() ||
    dataCutoff.getTime() > Date.now()
  ) {
    throw new RangeError('invalid prediction window');
  }
  signal?.throwIfAborted();

  const modelVersion = predictionModelConfig.version;
  const modelOptions = {
    strengths: { ...strengthModelOptions[competitionCode] },
    distribution: { ...predictionModelConfig.distribution },
  };
  const fixtures = await loadUpcomingFixtures(
    competitionCode,
    season,
    dataCutoff,
    until,
  );
  signal?.throwIfAborted();
  if (fixtures.length === 0) {
    return { fixtureCount: 0, publishedCount: 0, skippedCount: 0 };
  }

  const strengths = await loadCompetitionStrengths(
    competitionCode,
    season,
    dataCutoff,
    modelOptions.strengths,
  );
  signal?.throwIfAborted();

  let publishedCount = 0;
  for (const fixture of fixtures) {
    signal?.throwIfAborted();
    const home = strengths?.teams.find((team) => team.teamId === fixture.homeTeamId);
    const away = strengths?.teams.find((team) => team.teamId === fixture.awayTeamId);
    const expectedGoals = calculateExpectedGoals(
      strengths?.league ?? null,
      home?.home ?? null,
      away?.away ?? null,
    );
    if (expectedGoals === null) continue;

    const id = await publishPrediction({
      fixture,
      modelVersion,
      dataCutoff,
      expectedGoals,
      modelOptions,
    });
    if (id !== null) publishedCount += 1;
  }

  return {
    fixtureCount: fixtures.length,
    publishedCount,
    skippedCount: fixtures.length - publishedCount,
  };
}
