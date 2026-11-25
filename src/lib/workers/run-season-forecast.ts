import { wrap } from 'comlink';

import type {
  SeasonForecastWorkerApi,
  SeasonForecastWorkerRequest,
  SeasonForecastWorkerResult,
} from './season-forecast-api';

export type SeasonForecastProgress = Readonly<{
  completedRuns: number;
  totalRuns: number;
}>;

/** Run one local forecast in a dedicated worker. Aborting terminates that worker. */
export async function runSeasonForecastInWorker(
  request: SeasonForecastWorkerRequest,
  {
    onProgress,
    signal,
  }: Readonly<{
    onProgress?: (progress: SeasonForecastProgress) => void;
    signal?: AbortSignal;
  }> = {},
): Promise<SeasonForecastWorkerResult> {
  signal?.throwIfAborted();
  const worker = new Worker(
    new URL('./season-forecast.worker.ts', import.meta.url),
    {
      type: 'module',
    },
  );
  const totalRuns = request.input.runs;
  let stopped = false;
  let rejectInterruption!: (reason: unknown) => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });

  function stop(reason: unknown) {
    stopped = true;
    rejectInterruption(reason);
  }
  const onAbort = () => stop(signal?.reason);
  const onError = () => stop(new Error('season forecast worker failed'));
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onError);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const api = wrap<SeasonForecastWorkerApi>(worker);
    async function calculate(): Promise<SeasonForecastWorkerResult> {
      let update = await api.start(request);
      while (update.status === 'running') {
        if (stopped) return interruption;
        onProgress?.({ totalRuns, completedRuns: update.completedRuns });
        if (stopped) return interruption;
        update = await api.advance();
      }
      if (!stopped && update.status === 'complete')
        onProgress?.({ totalRuns, completedRuns: update.result.inputSnapshot.runs });
      return update;
    }

    return await Promise.race([calculate(), interruption]);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onError);
    worker.terminate();
  }
}
