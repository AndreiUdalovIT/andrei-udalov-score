import { z } from 'zod';

import { competitionSchema, seasonSchema, teamSchema } from './shared';

const countSchema = z.int().nonnegative();

const standingRowSchema = z.object({
  position: z.int().positive(),
  team: teamSchema.omit({ clubColors: true }),
  playedGames: countSchema,
  won: countSchema,
  draw: countSchema,
  lost: countSchema,
  // Official points can be negative after a deduction.
  points: z.int(),
  goalsFor: countSchema,
  goalsAgainst: countSchema,
  goalDifference: z.int(),
});

const standingSchema = z.object({
  stage: z.string().min(1),
  type: z.enum(['TOTAL', 'HOME', 'AWAY']),
  group: z.string().nullable(),
  table: z.array(standingRowSchema),
});

export const standingsResponseSchema = z.object({
  competition: competitionSchema,
  season: seasonSchema,
  standings: z.array(standingSchema),
});

export type ApiStandingRow = z.infer<typeof standingRowSchema>;
export type ApiStandingsResponse = z.infer<typeof standingsResponseSchema>;
