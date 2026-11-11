import { timingSafeEqual } from 'node:crypto';

import { revalidateTag } from 'next/cache';
import { z } from 'zod';

import { competitionConfig, type CompetitionCode } from '@/lib/config/competitions';
import { footballCacheTags } from '@/server/cache-tags';

const competitionCodes = Object.keys(competitionConfig) as CompetitionCode[];

const revalidationSchema = z.strictObject({
  mode: z.enum(['light', 'full', 'seed']),
  competitions: z
    .array(z.enum(competitionCodes))
    .min(1)
    .max(competitionCodes.length),
});

const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return Response.json(
      { error: 'revalidation is not configured' },
      { status: 503, headers },
    );
  }

  const authorization = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    authorization.length !== expected.length ||
    !timingSafeEqual(authorization, expected)
  ) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'invalid revalidation request' },
      { status: 400, headers },
    );
  }
  const parsed = revalidationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid revalidation request' },
      { status: 400, headers },
    );
  }

  const tags = new Set([
    footballCacheTags.teams,
    footballCacheTags.matches,
    ...parsed.data.competitions.map(footballCacheTags.competition),
  ]);
  if (parsed.data.mode !== 'light') tags.add(footballCacheTags.squads);

  try {
    for (const tag of tags) revalidateTag(tag, { expire: 0 });
  } catch {
    return Response.json(
      { error: 'cache could not be revalidated' },
      { status: 500, headers },
    );
  }

  return Response.json({ revalidated: true }, { headers });
}
