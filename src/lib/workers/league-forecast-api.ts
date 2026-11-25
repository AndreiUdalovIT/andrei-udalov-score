import {
  createLeagueSimulation,
  type LeagueSimulation,
  type LeagueSimulationInput,
  type LeagueSimulationResult,
  type LeagueSimulationUnavailability,
} from '../model/league-simulation';

export type LeagueForecastWorkerResult =
  | { status: 'complete'; result: LeagueSimulationResult }
  | { status: 'unavailable'; detail: LeagueSimulationUnavailability }
  | { status: 'unsupported' };

type Update =
  LeagueForecastWorkerResult | { status: 'running'; completedRuns: number };

const runsPerBatch = 100;

function readJob(job: LeagueSimulation): Update {
  if (job.unavailability !== null)
    return { status: 'unavailable', detail: job.unavailability };

  const result = job.result();
  if (result !== null) return { status: 'complete', result };
  if (job.status === 'ready' || job.status === 'running')
    return { status: 'running', completedRuns: job.completedRuns };

  throw new Error('league forecast did not complete');
}

export function createLeagueForecastWorkerApi() {
  let job: LeagueSimulation | null = null;
  return {
    start(input: LeagueSimulationInput): Update {
      if (job?.status === 'ready' || job?.status === 'running')
        throw new Error('a league forecast is already running');

      job = createLeagueSimulation(input);
      return job === null ? { status: 'unsupported' } : readJob(job);
    },

    advance(): Update {
      if (job === null) throw new Error('start a league forecast first');
      job.advance(runsPerBatch);
      return readJob(job);
    },
  };
}

export type LeagueForecastWorkerApi = ReturnType<
  typeof createLeagueForecastWorkerApi
>;
