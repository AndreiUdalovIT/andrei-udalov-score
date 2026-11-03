import { z } from 'zod';

import { MATCH_DURATIONS, MATCH_STATUSES } from '@/lib/types/football';

import { competitionSchema, idSchema, seasonSchema } from './shared';

const matchTeamSchema = z.object({
  id: idSchema.nullable(),
  name: z.string().nullable(),
  shortName: z.string().nullable().optional(),
  tla: z.string().nullable().optional(),
  crest: z.httpUrl().nullable().optional(),
});

const goalsSchema = z.int().nonnegative().nullable();
const scorePairSchema = z.object({
  home: goalsSchema,
  away: goalsSchema,
});

const scoreSchema = z.object({
  winner: z.enum(['HOME_TEAM', 'AWAY_TEAM', 'DRAW']).nullable(),
  duration: z.enum(MATCH_DURATIONS),
  fullTime: scorePairSchema,
  halfTime: scorePairSchema,
  // Keep the 90-minute score separate from extra time and shootout goals.
  regularTime: scorePairSchema.optional(),
  extraTime: scorePairSchema.optional(),
  penalties: scorePairSchema.optional(),
});

export const matchSchema = z.object({
  id: idSchema,
  competition: competitionSchema,
  season: seasonSchema,
  utcDate: z.iso.datetime(),
  status: z.enum(MATCH_STATUSES),
  matchday: z.int().nonnegative().nullable(),
  stage: z.string().min(1),
  homeTeam: matchTeamSchema,
  awayTeam: matchTeamSchema,
  score: scoreSchema,
  lastUpdated: z.iso.datetime(),
});

export const matchesResponseSchema = z.object({
  matches: z.array(matchSchema),
});

export type ApiMatch = z.infer<typeof matchSchema>;
export type ApiMatchesResponse = z.infer<typeof matchesResponseSchema>;
