import { wrap } from 'comlink';

import type { LeagueSimulationInput } from '../model/league-simulation';
import type {
  LeagueForecastWorkerApi,
  LeagueForecastWorkerResult,
} from './league-forecast-api';

export type LeagueForecastProgress = Readonly<{
  completedRuns: number;
  totalRuns: number;
}>;

/** Run one local forecast in a dedicated worker. Aborting terminates that worker. */
export async function runLeagueForecastInWorker(
  input: LeagueSimulationInput,
  {
    onProgress,
    signal,
  }: Readonly<{
    onProgress?: (progress: LeagueForecastProgress) => void;
    signal?: AbortSignal;
  }> = {},
): Promise<LeagueForecastWorkerResult> {
  signal?.throwIfAborted();
  const worker = new Worker(
    new URL('./league-forecast.worker.ts', import.meta.url),
    {
      type: 'module',
    },
  );
  const totalRuns = input.runs;
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
  const onError = () => stop(new Error('league forecast worker failed'));
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onError);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const api = wrap<LeagueForecastWorkerApi>(worker);
    async function calculate(): Promise<LeagueForecastWorkerResult> {
      let update = await api.start(input);
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
