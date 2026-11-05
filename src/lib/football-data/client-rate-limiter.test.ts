import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const TOKEN = 'test-token';
const fetchMock = vi.fn<typeof fetch>();
let createFootballDataClient: typeof import('./client').createFootballDataClient;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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

describe('football-data client rate limiting', () => {
  it('shares the queue between clients with the same normalized token', async () => {
    const requestCounter = { count: 0 };
    const first = createFootballDataClient({
      token: ` ${TOKEN} `,
      requestCounter,
    });
    const second = createFootballDataClient({ token: TOKEN, requestCounter });
    const requests = Promise.all([
      first.get('matches'),
      second.get('teams'),
      first.get('competitions'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestCounter.count).toBe(1);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestCounter.count).toBe(2);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(requests).resolves.toEqual([
      { matches: [] },
      { matches: [] },
      { matches: [] },
    ]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.football-data.org/v4/matches',
      'https://api.football-data.org/v4/teams',
      'https://api.football-data.org/v4/competitions',
    ]);
    expect(requestCounter.count).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts requests with different tokens independently', async () => {
    const first = createFootballDataClient({ token: TOKEN });
    const second = createFootballDataClient({ token: 'another-token' });

    const requests = Promise.all([first.get('matches'), second.get('teams')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await requests;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued request without fetching or delaying the next request', async () => {
    const client = createFootballDataClient({ token: TOKEN });
    await client.get('matches');
    const controller = new AbortController();
    const canceled = client.get('teams', { signal: controller.signal });
    const errorResult = canceled.catch((error: unknown) => error);
    const next = client.get('competitions');

    controller.abort(new Error(`Sensitive reason ${TOKEN}`));

    const error: unknown = await errorResult;
    expect(error).toMatchObject({
      name: 'AbortError',
      message: 'football-data request aborted',
    });
    expect(error).not.toHaveProperty('cause');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(next).resolves.toEqual({ matches: [] });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.football-data.org/v4/matches',
      'https://api.football-data.org/v4/competitions',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not take a slot for an unsafe path or an already aborted request', async () => {
    const requestCounter = { count: 0 };
    const client = createFootballDataClient({ token: TOKEN, requestCounter });

    await expect(client.get('../teams')).rejects.toThrow(
      'football-data path must stay within the v4 API',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.get('teams', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestCounter.count).toBe(0);
    await expect(client.get('matches')).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestCounter.count).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the request timeout after leaving the queue', async () => {
    const client = createFootballDataClient({ token: TOKEN, timeoutMs: 50 });
    await client.get('matches');
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Missing request signal');
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const assertion = expect(client.get('teams')).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'football-data request timed out',
    });

    await vi.advanceTimersByTimeAsync(5_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
