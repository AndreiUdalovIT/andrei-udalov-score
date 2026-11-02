import { z } from 'zod';

import { competitionSchema, seasonSchema, teamSchema } from './shared';

export const teamsResponseSchema = z.object({
  competition: competitionSchema,
  season: seasonSchema,
  teams: z.array(teamSchema),
});

export type ApiTeamsResponse = z.infer<typeof teamsResponseSchema>;
