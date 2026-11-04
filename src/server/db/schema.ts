// Database schema. Drizzle builds both the TypeScript types and the SQL
// migrations from this file. Where football-data.org has an id, it is the
// primary key: upserts need no lookups, and `/teams/57` is the row with id 57.
import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

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

/**
 * The overall table only. Home and away stats are computed from matches,
 * so the app does not depend on separate HOME/AWAY tables from the API.
 * The key also serves «the table of a competition».
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
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.season, t.teamId] })],
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
 * One row per sync run. «Обновлено N ч назад» reads the latest `ok`, so a
 * run that died while `running` does not hide the last good one.
 */
export const syncRuns = pgTable('sync_runs', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  mode: text().$type<SyncMode>().notNull(),
  status: text().$type<SyncStatus>().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
  /** football-data.org requests made, against the 10 per minute limit. */
  requests: integer().notNull().default(0),
  error: text(),
});
