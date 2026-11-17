import 'server-only';

import { z } from 'zod';

import { MATCH_STATUSES } from '@/lib/types/football';

import type { matches, predictions } from '../db/schema';

export type PredictionInput = Pick<
  typeof predictions.$inferInsert,
  'modelVersion' | 'dataCutoff' | 'expectedGoals'
> & {
  modelOptions: Omit<
    (typeof predictions.$inferInsert)['modelOptions'],
    'resultAvailability'
  >;
  fixture: Pick<
    typeof matches.$inferSelect,
    'id' | 'status' | 'utcDate' | 'homeTeamId' | 'awayTeamId'
  >;
};

export const predictionInputSchema = z.object({
  fixture: z.object({
    id: z.int32(),
    status: z.enum(MATCH_STATUSES),
    utcDate: z.date(),
    homeTeamId: z.int32().nullable(),
    awayTeamId: z.int32().nullable(),
  }),
  modelVersion: z.string().refine((version) => version.trim().length > 0),
  dataCutoff: z.date(),
  expectedGoals: z.object({
    home: z.number().nonnegative(),
    away: z.number().nonnegative(),
    lowData: z.boolean(),
  }),
  modelOptions: z.strictObject({
    strengths: z.strictObject({
      halfLifeDays: z.number().positive(),
      priorMatchCount: z.number().positive(),
      minEffectiveMatchCount: z.number().min(1),
      minTeamCount: z.int().positive(),
    }),
    distribution: z.strictObject({
      tailTolerance: z.number().gt(0).lt(1),
      maxGoals: z
        .int()
        .min(0)
        .max(2 ** 32 - 2),
    }),
  }),
}) satisfies z.ZodType<PredictionInput>;
