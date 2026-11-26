import 'server-only';

import { and, desc, eq, lt } from 'drizzle-orm';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { SiteCompetitionCode } from '@/lib/config/competitions';
import { predictionModelConfig } from '@/lib/config/model-predictions';
import type { ChampionsLeagueKnockoutStrengths } from '@/lib/model/champions-league-knockout-forecasts';
import { rankChampionsLeaguePhase } from '@/lib/model/champions-league-phase-ranking';
import { calculateExpectedGoals } from '@/lib/model/expected-goals';
import type { LeagueSimulationInput } from '@/lib/model/league-simulation';
import { selectTrainingMatches } from '@/lib/model/matches';
import { isPrematchFixture } from '@/lib/model/prediction-eligibility';
import type {
  SeasonCalendarFixture,
  SeasonFixtureScore,
} from '@/lib/model/season-calendar-sampler';
import type { RandomSeed } from '@/lib/model/seeded-random';
import { projectSeasonStats } from '@/lib/model/season-stats';

import { db } from '../db/client';
import { competitions, standingsSnapshots } from '../db/schema';
import { loadObservedCompetitionStrengthSnapshot } from '../queries/strengths';
type LeagueForecastInput = Omit<LeagueSimulationInput, 'runs'>;
type LeagueForecastInputOptions = Readonly<{ before: Date; seed: RandomSeed }>;
type FixtureIdentity = Pick<
  SeasonCalendarFixture,
  'id' | 'homeTeamId' | 'awayTeamId'
>;

export type LeagueForecastInputResult =
  | { status: 'ready'; input: LeagueForecastInput }
  | { status: 'unsupported' }
  | {
      status: 'unavailable';
      reason: 'official-table' | 'incomplete-calendar' | 'table-result-mismatch';
    }
  | {
      status: 'unavailable';
      reason: 'fixture-state' | 'fixture-rates';
      matchId: number;
    };

type LeagueTableSnapshotResult =
  | Exclude<LeagueForecastInputResult, { status: 'ready' }>
  | (Extract<LeagueForecastInputResult, { status: 'ready' }> & {
      knockoutStrengths: ChampionsLeagueKnockoutStrengths;
    });

async function loadOfficialTable(
  competitionCode: SiteCompetitionCode,
  season: number,
  before: Date,
) {
  try {
    const [table] = await db
      .select({ rows: standingsSnapshots.rows })
      .from(standingsSnapshots)
      .innerJoin(competitions, eq(standingsSnapshots.competitionId, competitions.id))
      .where(
        and(
          eq(competitions.code, competitionCode),
          eq(standingsSnapshots.season, season),
          eq(standingsSnapshots.source, 'official'),
          lt(standingsSnapshots.capturedAt, before),
        ),
      )
      .orderBy(desc(standingsSnapshots.capturedAt), desc(standingsSnapshots.id))
      .limit(1);
    return table?.rows ?? [];
  } catch {
    // Driver errors can include connection details or parameters.
    throw new Error('season forecast standings could not be loaded');
  }
}

/** Prepare an observed domestic calendar, retaining official point adjustments. */
export async function loadLeagueForecastInput(
  competitionCode: SiteCompetitionCode,
  season: number,
  options: LeagueForecastInputOptions,
): Promise<LeagueForecastInputResult> {
  const result = await loadObservedLeagueTableInput(
    competitionCode,
    season,
    options,
    'round-robin',
  );
  return result.status === 'ready'
    ? { status: 'ready', input: result.input }
    : result;
}

/** Prepare the observed calendar and table for the Champions League league phase. */
export function loadChampionsLeaguePhaseInput(
  season: number,
  options: LeagueForecastInputOptions,
): Promise<LeagueTableSnapshotResult> {
  return loadObservedLeagueTableInput('CL', season, options, 'league-phase');
}

async function loadObservedLeagueTableInput(
  competitionCode: SiteCompetitionCode,
  season: number,
  { before, seed }: LeagueForecastInputOptions,
  format: 'round-robin' | 'league-phase',
): Promise<LeagueTableSnapshotResult> {
  const dataCutoffMs = before.getTime();
  if (!Number.isFinite(dataCutoffMs) || dataCutoffMs > Date.now())
    throw new RangeError('season forecast requires a valid cutoff at or before now');

  const config = getCompetitionSeasonConfig(competitionCode, season);
  if (config?.format !== format) return { status: 'unsupported' };

  const cutoff = new Date(dataCutoffMs);
  const savedSeed: RandomSeed = [...seed];
  const table = await loadOfficialTable(competitionCode, season, cutoff);
  const teamIds = new Set(table.map(({ teamId }) => teamId));
  if (
    table.length !== config.teamCount ||
    teamIds.size !== config.teamCount ||
    table.some(({ stage }) => stage !== config.mainStage)
  ) {
    return { status: 'unavailable', reason: 'official-table' };
  }
  const baseline = table.map(
    ({ teamId, playedGames, won, draw, lost, points, goalsFor, goalsAgainst }) => ({
      teamId,
      playedGames,
      won,
      draw,
      lost,
      points,
      goalsFor,
      goalsAgainst,
    }),
  );

  const snapshot = await loadObservedCompetitionStrengthSnapshot(
    competitionCode,
    season,
    cutoff,
  );
  if (
    snapshot === null ||
    snapshot.matches.length !== (config.teamCount * config.matchdays) / 2
  ) {
    return { status: 'unavailable', reason: 'incomplete-calendar' };
  }

  const finished = new Map(
    selectTrainingMatches(snapshot.matches, cutoff).map((match) => [
      match.id,
      match,
    ]),
  );
  const pairs = new Set<string>();
  const known: Extract<SeasonCalendarFixture, { kind: 'known-result' }>[] = [];
  const upcoming: FixtureIdentity[] = [];
  for (const match of snapshot.matches) {
    const { id, homeTeamId, awayTeamId } = match;
    const pair = homeTeamId + ':' + awayTeamId;
    if (
      homeTeamId === null ||
      awayTeamId === null ||
      homeTeamId === awayTeamId ||
      !teamIds.has(homeTeamId) ||
      !teamIds.has(awayTeamId) ||
      pairs.has(pair)
    ) {
      return { status: 'unavailable', reason: 'incomplete-calendar' };
    }
    pairs.add(pair);

    const identity = { id, homeTeamId, awayTeamId };
    const result = finished.get(id);
    if (result !== undefined) {
      known.push({
        ...identity,
        kind: 'known-result',
        homeGoals90: result.homeGoals90,
        awayGoals90: result.awayGoals90,
      });
    } else if (isPrematchFixture(match) && match.utcDate.getTime() > dataCutoffMs) {
      upcoming.push(identity);
    } else {
      return { status: 'unavailable', reason: 'fixture-state', matchId: id };
    }
  }

  const scores: SeasonFixtureScore[] = known.map((score) => ({
    ...score,
    source: 'known-result',
  }));
  if (format === 'league-phase') {
    // Use score placeholders to validate the shape of the complete phase calendar.
    scores.push(
      ...upcoming.map((fixture) => ({
        ...fixture,
        source: 'simulated' as const,
        homeGoals90: 0,
        awayGoals90: 0,
      })),
    );
  }
  const projected = projectSeasonStats(baseline, scores);
  if (
    projected === null ||
    (format === 'league-phase' &&
      projected.some((row) => row.pointsAdjustment !== 0))
  ) {
    return { status: 'unavailable', reason: 'table-result-mismatch' };
  }
  if (
    format === 'league-phase' &&
    rankChampionsLeaguePhase(projected, scores, season) === null
  ) {
    return { status: 'unavailable', reason: 'incomplete-calendar' };
  }

  const { strengths } = snapshot;
  const strengthByTeam = new Map(strengths.teams.map((team) => [team.teamId, team]));
  const fixtures: SeasonCalendarFixture[] = [...known];
  for (const fixture of upcoming) {
    const rates = calculateExpectedGoals(
      strengths.league,
      strengthByTeam.get(fixture.homeTeamId)?.home ?? null,
      strengthByTeam.get(fixture.awayTeamId)?.away ?? null,
    );
    if (rates === null)
      return {
        status: 'unavailable',
        reason: 'fixture-rates',
        matchId: fixture.id,
      };
    fixtures.push({
      ...fixture,
      kind: 'forecast',
      homeRate90: rates.home,
      awayRate90: rates.away,
    });
  }

  return {
    status: 'ready',
    knockoutStrengths: { league: strengths.league, teams: strengths.teams },
    input: {
      competitionCode,
      season,
      modelVersion: predictionModelConfig.version,
      dataCutoffMs,
      seed: savedSeed,
      sampling: predictionModelConfig.distribution,
      baseline,
      fixtures,
    },
  };
}
