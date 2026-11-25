// Database schema. Drizzle builds both the TypeScript types and the SQL
// migrations from this file. Where football-data.org has an id, it is the
// primary key: upserts need no lookups, and `/teams/57` is the row with id 57.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { StoredChampionsLeagueForecast } from '@/lib/model/champions-league-knockout-snapshot';
import type { ExpectedGoals } from '@/lib/model/expected-goals';
import type { LeagueSimulationResult } from '@/lib/model/league-simulation';
import type { MatchProbabilities } from '@/lib/model/match-probabilities';
import type { PoissonDistributionOptions } from '@/lib/model/poisson-distribution';
import type { PromotionAdjustmentOptions } from '@/lib/model/promotion-adjustment';
import type { RandomSeed } from '@/lib/model/seeded-random';
import type { MatchDuration, MatchStatus } from '@/lib/types/football';

export const competitions = pgTable('competitions', {
  id: integer().primaryKey(),
  /** Upper case, as in the API: 'PL'. URLs use lower case. */
  code: text().notNull().unique(),
  name: text().notNull(),
  emblem: text(),
  currentMatchday: integer(),
});

export const teams = pgTable('teams', {
  id: integer().primaryKey(),
  name: text().notNull(),
  // The API sometimes sends null; the mapper falls back to the name.
  shortName: text().notNull(),
  tla: text().notNull(),
  crest: text(),
  clubColors: text(),
});

/** Which teams play in a competition in a given season. */
export const teamCompetitions = pgTable(
  'team_competitions',
  {
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    /** Year the season starts: 2026 is 2026/27, as in the API. */
    season: integer().notNull(),
    teamId: integer()
      .notNull()
      .references(() => teams.id),
  },
  (t) => [
    primaryKey({ columns: [t.competitionId, t.season, t.teamId] }),
    index('team_competitions_team_idx').on(t.teamId),
  ],
);

export const matches = pgTable(
  'matches',
  {
    id: integer().primaryKey(),
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    matchday: integer(),
    /** 'REGULAR_SEASON', 'LEAGUE_STAGE', 'LAST_16'… */
    stage: text().notNull(),
    // A stored UTC instant; converted to the browser's time zone only on screen.
    utcDate: timestamp({ withTimezone: true }).notNull(),
    // Text, not a database enum: a new API status needs no migration.
    status: text().$type<MatchStatus>().notNull(),
    // Null until the opponent is known: knockout ties are scheduled early.
    homeTeamId: integer().references(() => teams.id),
    awayTeamId: integer().references(() => teams.id),
    /** The score shown to people. */
    homeGoals: integer(),
    awayGoals: integer(),
    /** Goals in 90 minutes, for the model: extra time would skew it. */
    homeGoals90: integer(),
    awayGoals90: integer(),
    duration: text().$type<MatchDuration>().notNull(),
    homePenalties: integer(),
    awayPenalties: integer(),
    lastUpdated: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index('matches_competition_date_idx').on(t.competitionId, t.utcDate),
    index('matches_home_team_idx').on(t.homeTeamId),
    index('matches_away_team_idx').on(t.awayTeamId),
  ],
);

export type MatchObservationSource = 'baseline' | 'change';

/** Match states captured for replaying the information observed over time. */
export const matchObservations = pgTable(
  'match_observations',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    matchId: integer()
      .notNull()
      .references(() => matches.id),
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    matchday: integer(),
    stage: text().notNull(),
    utcDate: timestamp({ withTimezone: true }).notNull(),
    status: text().$type<MatchStatus>().notNull(),
    homeTeamId: integer().references(() => teams.id),
    awayTeamId: integer().references(() => teams.id),
    homeGoals: integer(),
    awayGoals: integer(),
    homeGoals90: integer(),
    awayGoals90: integer(),
    duration: text().$type<MatchDuration>().notNull(),
    homePenalties: integer(),
    awayPenalties: integer(),
    /** API update timestamp retained with the captured state. */
    lastUpdated: timestamp({ withTimezone: true }).notNull(),
    /** Database receipt time of this observation. */
    observedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    source: text().$type<MatchObservationSource>().notNull(),
  },
  (t) => [
    index('match_observations_lookup_idx').on(t.matchId, t.observedAt, t.id),
    index('match_observations_scope_idx').on(
      t.competitionId,
      t.season,
      t.observedAt,
      t.matchId,
    ),
    check(
      'match_observations_source_check',
      sql`${t.source} in ('baseline', 'change')`,
    ),
    check('match_observations_observed_at_check', sql`isfinite(${t.observedAt})`),
  ],
);

export type PredictionSource = 'published' | 'backtest';

/** Stored results with their fixture snapshot and model settings. */
export const predictions = pgTable(
  'predictions',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    matchId: integer()
      .notNull()
      .references(() => matches.id),
    source: text().$type<PredictionSource>().notNull(),
    modelVersion: text().notNull(),
    homeTeamId: integer()
      .notNull()
      .references(() => teams.id),
    awayTeamId: integer()
      .notNull()
      .references(() => teams.id),
    kickoffAt: timestamp({ withTimezone: true }).notNull(),
    dataCutoff: timestamp({ withTimezone: true }).notNull(),
    calculatedAt: timestamp({ withTimezone: true }).notNull(),
    recordedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** Published forecasts use recordedAt. Backtests keep this null. */
    publishedAt: timestamp({ withTimezone: true }),
    expectedGoals: jsonb().$type<ExpectedGoals>().notNull(),
    probabilities: jsonb().$type<MatchProbabilities>().notNull(),
    modelOptions: jsonb()
      .$type<{
        strengths: PromotionAdjustmentOptions;
        distribution: PoissonDistributionOptions;
        /** Input availability recorded for observed retrospective forecasts. */
        resultAvailability?: { mode: 'observed'; delayHours: null };
      }>()
      .notNull(),
  },
  (t) => [
    uniqueIndex('predictions_fixture_cutoff_idx').on(
      t.matchId,
      t.source,
      t.modelVersion,
      t.homeTeamId,
      t.awayTeamId,
      t.kickoffAt,
      t.dataCutoff,
    ),
    index('predictions_lookup_idx').on(
      t.matchId,
      t.source,
      t.modelVersion,
      t.dataCutoff,
      t.recordedAt,
      t.id,
    ),
    check('predictions_source_check', sql`${t.source} in ('published', 'backtest')`),
    check('predictions_version_check', sql`btrim(${t.modelVersion}) <> ''`),
    check('predictions_teams_check', sql`${t.homeTeamId} <> ${t.awayTeamId}`),
    check(
      'predictions_finite_times_check',
      sql`isfinite(${t.kickoffAt}) and isfinite(${t.dataCutoff})
        and isfinite(${t.calculatedAt}) and isfinite(${t.recordedAt})`,
    ),
    check(
      'predictions_timing_check',
      sql`${t.dataCutoff} <= ${t.calculatedAt}
        and ${t.calculatedAt} <= ${t.recordedAt}
        and ${t.dataCutoff} <= ${t.kickoffAt}`,
    ),
    check(
      'predictions_publication_check',
      sql`(
        ${t.source} = 'published' and ${t.publishedAt} is not null
        and ${t.publishedAt} = ${t.recordedAt}
        and ${t.publishedAt} < ${t.kickoffAt}
      ) or (
        ${t.source} = 'backtest' and ${t.publishedAt} is null
      )`,
    ),
    check(
      'predictions_payload_objects_check',
      sql`jsonb_typeof(${t.expectedGoals}) = 'object'
        and jsonb_typeof(${t.probabilities}) = 'object'
        and jsonb_typeof(${t.modelOptions}) = 'object'`,
    ),
  ],
);

export type SeasonForecastKind = 'league-table' | 'champions-league-stages';

/** Completed season forecasts with their reproducibility metadata. */
export const seasonForecasts = pgTable(
  'season_forecasts',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    kind: text().$type<SeasonForecastKind>().notNull(),
    modelVersion: text().notNull(),
    dataCutoff: timestamp({ withTimezone: true }).notNull(),
    calculatedAt: timestamp({ withTimezone: true }).notNull(),
    recordedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    seed: bigint({ mode: 'number' }).array(4).$type<RandomSeed>().notNull(),
    runs: integer().notNull(),
    forecast: jsonb()
      .$type<LeagueSimulationResult | StoredChampionsLeagueForecast>()
      .notNull(),
  },
  (t) => [
    index('season_forecasts_lookup_idx').on(
      t.competitionId,
      t.season,
      t.kind,
      t.dataCutoff,
      t.calculatedAt,
      t.id,
    ),
    check(
      'season_forecasts_kind_check',
      sql`${t.kind} in ('league-table', 'champions-league-stages')`,
    ),
    check('season_forecasts_version_check', sql`btrim(${t.modelVersion}) <> ''`),
    check(
      'season_forecasts_season_runs_check',
      sql`${t.season} > 0 and ${t.runs} > 0`,
    ),
    check(
      'season_forecasts_times_check',
      sql`isfinite(${t.dataCutoff}) and isfinite(${t.calculatedAt}) and isfinite(${t.recordedAt})
        and ${t.dataCutoff} <= ${t.calculatedAt} and ${t.calculatedAt} <= ${t.recordedAt}`,
    ),
    check(
      'season_forecasts_seed_check',
      sql`case when array_ndims(${t.seed}) = 1 then
        array_lower(${t.seed}, 1) = 1 and cardinality(${t.seed}) = 4
        and array_position(${t.seed}, null) is null
        and 0 <= all(${t.seed}) and 4294967295 >= all(${t.seed})
        and 0 < any(${t.seed})
        else false end`,
    ),
    check(
      'season_forecasts_payload_check',
      sql`jsonb_typeof(${t.forecast}) = 'object'`,
    ),
  ],
);

/**
 * TOTAL standings retain the stage and group of each table.
 * Home and away stats are computed from matches.
 */
export const standings = pgTable(
  'standings',
  {
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    teamId: integer()
      .notNull()
      .references(() => teams.id),
    position: integer().notNull(),
    playedGames: integer().notNull(),
    won: integer().notNull(),
    draw: integer().notNull(),
    lost: integer().notNull(),
    points: integer().notNull(),
    goalsFor: integer().notNull(),
    goalsAgainst: integer().notNull(),
    // Legacy snapshots have no context until their next standings sync.
    stage: text(),
    group: text(),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.season, t.teamId] })],
);

export type StandingsSnapshotSource = 'official' | 'reconstructed';

/** Complete TOTAL table captures with their source and receipt time. */
export const standingsSnapshots = pgTable(
  'standings_snapshots',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    source: text().$type<StandingsSnapshotSource>().notNull(),
    /** Requested round for reconstruction. Official API rounds may be unknown. */
    matchday: integer(),
    /** When the API response was received. */
    capturedAt: timestamp({ withTimezone: true }).notNull(),
    rows: jsonb()
      .$type<Omit<typeof standings.$inferSelect, 'competitionId' | 'season'>[]>()
      .notNull(),
  },
  (t) => [
    index('standings_snapshots_lookup_idx').on(
      t.competitionId,
      t.season,
      t.source,
      t.matchday,
      t.capturedAt,
      t.id,
    ),
  ],
);

export const scorers = pgTable(
  'scorers',
  {
    competitionId: integer()
      .notNull()
      .references(() => competitions.id),
    season: integer().notNull(),
    playerId: integer().notNull(),
    // Kept here: a scorer may have left the club and no longer be in a squad.
    playerName: text().notNull(),
    teamId: integer()
      .notNull()
      .references(() => teams.id),
    playedMatches: integer().notNull().default(0),
    goals: integer().notNull().default(0),
    // Preserve unknown API statistics; a confirmed zero is stored as 0.
    assists: integer(),
    penalties: integer(),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.season, t.playerId] })],
);

/** Current squads; the API has no shirt numbers. */
export const squadPlayers = pgTable(
  'squad_players',
  {
    id: integer().primaryKey(),
    teamId: integer()
      .notNull()
      .references(() => teams.id),
    name: text().notNull(),
    position: text(),
    // A calendar date, not an instant: the age must not shift with time zones.
    dateOfBirth: date({ mode: 'string' }),
    nationality: text(),
  },
  (t) => [index('squad_players_team_idx').on(t.teamId)],
);

export type SyncMode = 'light' | 'full' | 'seed';
export type SyncStatus = 'running' | 'ok' | 'error';

/**
 * One row per sync run. Freshness queries use successful runs that cover the
 * requested competitions. Legacy runs have an unknown scope.
 */
export const syncRuns = pgTable('sync_runs', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  mode: text().$type<SyncMode>().notNull(),
  /** Normalized competition codes. Null means the scope of a legacy run is unknown. */
  competitionCodes: text().array(),
  status: text().$type<SyncStatus>().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
  /** football-data.org requests made, against the 10 per minute limit. */
  requests: integer().notNull().default(0),
  error: text(),
});
