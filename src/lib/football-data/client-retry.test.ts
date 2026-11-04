import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const TOKEN = 'test-token';
const fetchMock = vi.fn<typeof fetch>();
let createFootballDataClient: typeof import('./client').createFootballDataClient;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
  });
  vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async () => Response.json({ matches: [] }));
  ({ createFootballDataClient } = await import('./client'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe('football-data client retries', () => {
  it('retries server errors with increasing delays after slow responses', async () => {
    const failAfter = (status: number) => () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(null, { status })), 7_000);
      });
    fetchMock
      .mockImplementationOnce(failAfter(500))
      .mockImplementationOnce(failAfter(503));
    const client = createFootballDataClient({ token: TOKEN });

    const result = client.get('matches');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after three attempts and preserves the final quota cooldown', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 429 }));
    const client = createFootballDataClient({ token: TOKEN });
    const assertion = expect(client.get('matches')).rejects.toMatchObject({
      name: 'FootballDataHttpError',
      status: 429,
      retryAfter: null,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockImplementation(async () => Response.json({ matches: [] }));
    const next = client.get('matches');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(next).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a retry while keeping Retry-After shared with another client', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
    );
    const client = createFootballDataClient({ token: TOKEN });
    const controller = new AbortController();
    const errorResult = client
      .get('matches', { signal: controller.signal })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error(`Sensitive reason ${TOKEN}`));

    const error: unknown = await errorResult;
    expect(error).toMatchObject({
      name: 'AbortError',
      message: 'football-data request aborted',
    });
    expect(error).not.toHaveProperty('cause');
    expect(vi.getTimerCount()).toBe(0);

    const other = createFootballDataClient({ token: ` ${TOKEN} ` });
    const next = other.get('teams');
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(next).resolves.toEqual({ matches: [] });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.football-data.org/v4/matches',
      'https://api.football-data.org/v4/teams',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'Wed, 04 Nov 2026 00:00:12 GMT',
    'Wednesday, 04-Nov-26 00:00:12 GMT',
    'Wed Nov  4 00:00:12 2026',
  ])('honors the HTTP-date Retry-After %s in UTC', async (retryAfter) => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { 'Retry-After': retryAfter } }),
    );
    const client = createFootballDataClient({ token: TOKEN });

    const result = client.get('matches');
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['-1', '1.5'])(
    'uses the quota fallback for an invalid numeric Retry-After %s',
    async (retryAfter) => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }),
      );
      const client = createFootballDataClient({ token: TOKEN });

      const result = client.get('matches');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual({ matches: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['2147484', 'Thursday, 04-Nov-60 00:00:00 GMT'])(
    'does not retry early when Retry-After %s exceeds the timer range',
    async (retryAfter) => {
      fetchMock.mockResolvedValue(
        new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }),
      );
      const client = createFootballDataClient({ token: TOKEN });

      await expect(client.get('matches')).rejects.toMatchObject({
        name: 'FootballDataHttpError',
        status: 429,
        retryAfter,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
