import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn<(tag: string, profile: { expire: number }) => void>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }));

const SECRET = 'a'.repeat(64);

function request(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return new Request('http://localhost/api/revalidate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization === null ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('REVALIDATE_SECRET', SECRET);
  mocks.revalidateTag.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cache revalidation endpoint', () => {
  it.each([null, 'Bearer wrong', `Bearer ${'b'.repeat(64)}`])(
    'rejects authorization %s before reading the body',
    async (authorization) => {
      const input = request({ mode: 'full', competitions: ['PL'] }, authorization);
      const readBody = vi.spyOn(input, 'json');

      const response = await POST(input);

      expect(response.status).toBe(401);
      expect(readBody).not.toHaveBeenCalled();
      expect(mocks.revalidateTag).not.toHaveBeenCalled();
    },
  );

  it('disables revalidation when the server secret is missing', async () => {
    vi.stubEnv('REVALIDATE_SECRET', undefined);

    const response = await POST(request({ mode: 'full', competitions: ['PL'] }));

    expect(response.status).toBe(503);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'unknown', competitions: ['PL'] },
    { mode: 'full', competitions: [] },
    { mode: 'full', competitions: ['UNKNOWN'] },
    { mode: 'full', competitions: ['PL'], tags: ['arbitrary-tag'] },
  ])('rejects an invalid scope %j before invalidating any tag', async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without invalidating any tag', async () => {
    const input = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
      body: '{',
    });

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it.each(['light', 'full', 'seed'] as const)(
    'expires the affected tags for %s and deduplicates competitions',
    async (mode) => {
      const response = await POST(
        request({ mode, competitions: ['PL', 'CL', 'PL'] }),
      );
      const expectedTags = [
        'football:teams',
        'football:matches',
        'football:competition:PL',
        'football:competition:CL',
        ...(mode === 'light' ? [] : ['football:squads']),
      ];

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ revalidated: true });
      expect(mocks.revalidateTag).toHaveBeenCalledTimes(expectedTags.length);
      expect(new Set(mocks.revalidateTag.mock.calls.map(([tag]) => tag))).toEqual(
        new Set(expectedTags),
      );
      for (const [, profile] of mocks.revalidateTag.mock.calls) {
        expect(profile).toEqual({ expire: 0 });
      }
    },
  );

  it('reports cache failure without exposing internal details', async () => {
    mocks.revalidateTag.mockImplementationOnce(() => {
      throw new Error(`Internal details: ${SECRET}`);
    });

    const response = await POST(request({ mode: 'full', competitions: ['PL'] }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'cache could not be revalidated',
    });
  });
});
