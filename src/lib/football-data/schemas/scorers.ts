import { z } from 'zod';

import { competitionSchema, idSchema, seasonSchema, teamSchema } from './shared';

const countSchema = z.int().nonnegative();

const scorerSchema = z.object({
  player: z.object({
    id: idSchema,
    name: z.string().min(1),
  }),
  team: teamSchema.omit({ clubColors: true }),
  playedMatches: countSchema,
  goals: countSchema,
  // Missing statistics stay unknown; null is not a confirmed zero.
  assists: countSchema.nullable(),
  penalties: countSchema.nullable(),
});

export const scorersResponseSchema = z.object({
  competition: competitionSchema,
  season: seasonSchema,
  scorers: z.array(scorerSchema),
});

export type ApiScorer = z.infer<typeof scorerSchema>;
export type ApiScorersResponse = z.infer<typeof scorersResponseSchema>;
