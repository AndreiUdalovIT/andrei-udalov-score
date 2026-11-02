import { z } from 'zod';

const idSchema = z.int().positive();

export const competitionSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  code: z.string().min(1),
  emblem: z.httpUrl().nullable(),
});

export const seasonSchema = z.object({
  id: idSchema,
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  currentMatchday: z.int().nonnegative().nullable(),
});

export const teamSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  shortName: z.string().nullable(),
  tla: z.string().nullable(),
  crest: z.httpUrl().nullable(),
  clubColors: z.string().nullable(),
});
