import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFootballDataClient } from './client';

vi.mock('server-only', () => ({}));

vi.mock('./rate-limiter', () => ({
  createRateLimiter: () => ({
    pause: () => undefined,
    run: <T>(task: () => Promise<T>) => task(),
  }),
}));

const TOKEN = 'test-token';
const fetchMock = vi.fn<typeof fetch>();

function mockPendingRequest() {
  fetchMock.mockImplementation((_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Missing request signal');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe('football-data client', () => {
  it('sends an authenticated GET and preserves null values in the JSON response', async () => {
    const data = { matches: [{ id: 1, homeTeam: { id: null } }] };
    fetchMock.mockResolvedValue(Response.json(data));
    const client = createFootballDataClient({ token: TOKEN });

    await expect(
      client.get('competitions/PL/matches', {
        params: { season: 2026, status: 'FINISHED' },
      }),
    ).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.football-data.org/v4/competitions/PL/matches?season=2026&status=FINISHED',
      ),
      {
        method: 'GET',
        headers: { 'X-Auth-Token': TOKEN, Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('reads the token from the server environment', async () => {
    vi.stubEnv('FOOTBALL_DATA_TOKEN', TOKEN);
    fetchMock.mockResolvedValue(Response.json({ teams: [] }));

    await createFootballDataClient().get('teams');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'X-Auth-Token': TOKEN,
      Accept: 'application/json',
    });
  });

  it.each(['', '   '])(
    'rejects an empty token %j before making a request',
    (token) => {
      expect(() => createFootballDataClient({ token })).toThrow(
        'FOOTBALL_DATA_TOKEN is not set',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Infinity, 2_147_483_648])(
    'rejects an invalid timeout %s',
    (timeoutMs) => {
      expect(() => createFootballDataClient({ token: TOKEN, timeoutMs })).toThrow(
        RangeError,
      );
    },
  );

  it.each([
    'https://example.com/collect',
    '//example.com/collect',
    '../teams/57',
    'https://user:pass@api.football-data.org/v4/matches',
  ])('rejects an unsafe resource path %s before sending the token', async (path) => {
    const client = createFootballDataClient({ token: TOKEN });

    await expect(client.get(path)).rejects.toThrow(
      'football-data path must stay within the v4 API',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, attempts: 1 },
    { status: 403, attempts: 1 },
    { status: 404, attempts: 1 },
    { status: 429, attempts: 3 },
    { status: 500, attempts: 3 },
    { status: 503, attempts: 3 },
  ])(
    'preserves HTTP $status without exposing the response body',
    async ({ status, attempts }) => {
      fetchMock.mockResolvedValue(
        new Response('Sensitive upstream body', { status }),
      );
      const client = createFootballDataClient({ token: TOKEN });

      await expect(client.get('matches')).rejects.toMatchObject({
        name: 'FootballDataHttpError',
        message: `football-data request failed with HTTP ${status}`,
        status,
        retryAfter: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    },
  );

  it('preserves Retry-After when retries are exhausted', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
    );
    const client = createFootballDataClient({ token: TOKEN });

    await expect(client.get('matches')).rejects.toMatchObject({
      status: 429,
      retryAfter: '12',
    });
  });

  it('reports malformed JSON without exposing the response body', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Sensitive upstream body</html>'),
    );
    const client = createFootballDataClient({ token: TOKEN });

    await expect(client.get('matches')).rejects.toMatchObject({
      message: 'football-data returned invalid JSON',
    });
  });

  it('does not expose the original network error or its credentials', async () => {
    fetchMock.mockRejectedValue(new Error(`Failed with token ${TOKEN}`));
    const client = createFootballDataClient({ token: TOKEN });

    const request = client.get('matches');
    await expect(request).rejects.toMatchObject({
      message: 'football-data request failed',
    });
    await expect(request).rejects.not.toHaveProperty('cause');
  });

  it('does not send an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createFootballDataClient({ token: TOKEN });

    await expect(
      client.get('matches', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a pending request without exposing the caller abort reason', async () => {
    mockPendingRequest();
    const controller = new AbortController();
    const client = createFootballDataClient({ token: TOKEN });
    const assertion = expect(
      client.get('matches', { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'football-data request aborted',
    });

    controller.abort(new Error(`Sensitive reason ${TOKEN}`));
    await assertion;
  });

  it('aborts a request that exceeds the timeout', async () => {
    vi.useFakeTimers();
    mockPendingRequest();
    const client = createFootballDataClient({ token: TOKEN, timeoutMs: 50 });
    const assertion = expect(client.get('matches')).rejects.toMatchObject({
      name: 'TimeoutError',
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also times out while reading the response body', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const client = createFootballDataClient({ token: TOKEN, timeoutMs: 50 });
    const assertion = expect(client.get('matches')).rejects.toMatchObject({
      name: 'TimeoutError',
    });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout after a successful response', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(Response.json({ matches: [] }));
    const client = createFootballDataClient({ token: TOKEN });

    await client.get('matches');
    expect(vi.getTimerCount()).toBe(0);
  });
});
