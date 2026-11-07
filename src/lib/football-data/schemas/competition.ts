import { z } from 'zod';

import { competitionSchema, seasonSchema } from './shared';

export const competitionResponseSchema = competitionSchema.extend({
  currentSeason: seasonSchema,
  seasons: z.array(seasonSchema),
});

export type ApiCompetitionResponse = z.infer<typeof competitionResponseSchema>;
