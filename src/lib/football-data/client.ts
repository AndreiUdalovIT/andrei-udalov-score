import 'server-only';

const API_URL = new URL('https://api.football-data.org/v4/');

type ClientOptions = {
  token?: string;
  timeoutMs?: number;
};

type GetOptions = {
  params?: Record<string, string | number>;
  signal?: AbortSignal;
};

export class FootballDataHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`football-data request failed with HTTP ${status}`);
    this.name = 'FootballDataHttpError';
  }
}

export function createFootballDataClient({
  token = process.env.FOOTBALL_DATA_TOKEN,
  timeoutMs = 10_000,
}: ClientOptions = {}) {
  const authToken = token?.trim();
  if (!authToken) throw new Error('FOOTBALL_DATA_TOKEN is not set');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
  }

  return {
    async get(path: string, { params, signal }: GetOptions = {}): Promise<unknown> {
      const url = new URL(path, API_URL);
      if (
        url.origin !== API_URL.origin ||
        !url.pathname.startsWith(API_URL.pathname) ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error('football-data path must stay within the v4 API');
      }
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, String(value));
      }

      const timeoutController = new AbortController();
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      // Keep the timeout active until the response body has also been read.
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

      try {
        requestSignal.throwIfAborted();
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'X-Auth-Token': authToken, Accept: 'application/json' },
          cache: 'no-store',
          // Never forward the token to a redirect target.
          redirect: 'error',
          signal: requestSignal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new FootballDataHttpError(
            response.status,
            response.headers.get('Retry-After'),
          );
        }

        const data: unknown = await response.json();
        requestSignal.throwIfAborted();
        return data;
      } catch (error) {
        if (signal?.aborted) {
          throw new DOMException('football-data request aborted', 'AbortError');
        }
        if (timeoutController.signal.aborted) {
          throw new DOMException('football-data request timed out', 'TimeoutError');
        }
        if (error instanceof FootballDataHttpError) throw error;
        if (error instanceof SyntaxError) {
          throw new Error('football-data returned invalid JSON');
        }
        // Upstream errors can contain credentials; expose only a fixed message.
        throw new Error('football-data request failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
