import 'server-only';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type PendingTask = {
  start: () => void;
};

function createAbortError() {
  return new DOMException('football-data request aborted', 'AbortError');
}

export function createRateLimiter(intervalMs = 6_000) {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError('intervalMs must be an integer between 1 and 2147483647');
  }

  const queue: PendingTask[] = [];
  let nextStartAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pump(): void {
    if (timer !== undefined || queue.length === 0) return;

    const delay = nextStartAt - performance.now();
    if (delay > 0) {
      timer = setTimeout(
        () => {
          timer = undefined;
          pump();
        },
        Math.min(Math.ceil(delay), MAX_TIMER_DELAY_MS),
      );
      return;
    }

    const entry = queue.shift();
    if (!entry) return;

    // Base the next slot on the actual start, so late timers cannot cause a burst.
    nextStartAt = performance.now() + intervalMs;
    entry.start();
    pump();
  }

  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(createAbortError());

      return new Promise<T>((resolve, reject) => {
        const entry: PendingTask = {
          start() {
            // Once started, the task handles its own cancellation.
            signal?.removeEventListener('abort', abort);
            try {
              resolve(task());
            } catch (error) {
              reject(error);
            }
          },
        };

        function abort() {
          const index = queue.indexOf(entry);
          if (index === -1) return;

          queue.splice(index, 1);
          signal?.removeEventListener('abort', abort);
          reject(createAbortError());

          if (queue.length === 0 && timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        }

        queue.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
        pump();
      });
    },
  };
}
