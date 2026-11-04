import { z } from 'zod';

import { idSchema, teamSchema } from './shared';

const squadPlayerSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  position: z.string().nullable(),
  dateOfBirth: z.iso.date().nullable(),
  nationality: z.string().nullable(),
});

export const squadResponseSchema = teamSchema.extend({
  squad: z.array(squadPlayerSchema),
});

export type ApiSquadPlayer = z.infer<typeof squadPlayerSchema>;
export type ApiSquadResponse = z.infer<typeof squadResponseSchema>;
