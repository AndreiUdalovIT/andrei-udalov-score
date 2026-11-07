import 'server-only';

import { createRateLimiter } from './rate-limiter';

const API_URL = new URL('https://api.football-data.org/v4/');
const MAX_RETRIES = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Clients using the same token share a request queue within this module.
const rateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();

export type ClientOptions = {
  token?: string;
  timeoutMs?: number;
  /** HTTP attempts started, including retries. Share one counter per sync run. */
  requestCounter?: { count: number };
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

function getRetryDelay(
  error: FootballDataHttpError,
  attempt: number,
): number | null {
  if (error.status !== 429 && (error.status < 500 || error.status > 599)) {
    return null;
  }

  const fallback = error.status === 429 ? 60_000 : 1_000 * 2 ** attempt;
  const value = error.retryAfter?.trim();
  if (!value) return fallback;

  let delayMs: number;
  if (/^\d+$/.test(value)) {
    delayMs = Number(value) * 1_000;
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/.test(value)) {
    const now = Date.now();
    const currentYear = new Date(now).getUTCFullYear();
    let date = value.endsWith('GMT') ? value : `${value} GMT`;
    // Expand two-digit years using HTTP's rolling 50-year window.
    date = date.replace(/-(\d{2})(?= )/, (_match, shortYear: string) => {
      let year = Math.floor(currentYear / 100) * 100 + Number(shortYear);
      if (year > currentYear + 50) year -= 100;
      else if (year < currentYear - 49) year += 100;
      return `-${year}`;
    });
    delayMs = Date.parse(date) - now;
  } else {
    return fallback;
  }

  if (delayMs > MAX_TIMER_DELAY_MS) return null;
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : fallback;
}

export function createFootballDataClient({
  token = process.env.FOOTBALL_DATA_TOKEN,
  timeoutMs = 10_000,
  requestCounter,
}: ClientOptions = {}) {
  const authToken = token?.trim();
  if (!authToken) throw new Error('FOOTBALL_DATA_TOKEN is not set');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
  }

  const rateLimiter = rateLimiters.get(authToken) ?? createRateLimiter();
  rateLimiters.set(authToken, rateLimiter);

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

      const request = async () => {
        const timeoutController = new AbortController();
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal;
        // Keep the timeout active until the response body has also been read.
        const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

        try {
          requestSignal.throwIfAborted();
          if (requestCounter) requestCounter.count += 1;
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
            throw new DOMException(
              'football-data request timed out',
              'TimeoutError',
            );
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
      };

      for (let attempt = 0; ; attempt++) {
        try {
          return await rateLimiter.run(request, signal);
        } catch (error) {
          if (!(error instanceof FootballDataHttpError)) throw error;
          const delayMs = getRetryDelay(error, attempt);
          if (delayMs === null) throw error;

          // Preserve the shared cooldown even after the final failed attempt.
          rateLimiter.pause(delayMs);
          if (attempt >= MAX_RETRIES) throw error;
        }
      }
    },
  };
}
