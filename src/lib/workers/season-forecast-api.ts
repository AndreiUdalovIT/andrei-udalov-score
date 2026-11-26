import {
  createChampionsLeagueForecast,
  type ChampionsLeagueForecast,
  type ChampionsLeagueForecastResult,
  type ChampionsLeagueForecastUnavailability,
} from '../model/champions-league-forecast';
import {
  restoreChampionsLeagueForecastInput,
  type ReplayableChampionsLeagueInput,
} from '../model/champions-league-knockout-snapshot';
import {
  createLeagueSimulation,
  type LeagueSimulation,
  type LeagueSimulationInput,
  type LeagueSimulationResult,
  type LeagueSimulationUnavailability,
} from '../model/league-simulation';

export type SeasonForecastWorkerRequest =
  | { kind: 'league-table'; input: LeagueSimulationInput }
  | { kind: 'champions-league-stages'; input: ReplayableChampionsLeagueInput };

export type SeasonForecastWorkerResult =
  | {
      status: 'complete';
      result: LeagueSimulationResult | ChampionsLeagueForecastResult;
    }
  | {
      status: 'unavailable';
      detail: LeagueSimulationUnavailability | ChampionsLeagueForecastUnavailability;
    }
  | { status: 'unsupported' };

type Job = LeagueSimulation | ChampionsLeagueForecast;

type Update =
  SeasonForecastWorkerResult | { status: 'running'; completedRuns: number };

const runsPerBatch = 100;

function readJob(job: Job): Update {
  if (job.unavailability !== null)
    return { status: 'unavailable', detail: job.unavailability };

  const result = job.result();
  if (result !== null) return { status: 'complete', result };
  if (job.status === 'ready' || job.status === 'running')
    return { status: 'running', completedRuns: job.completedRuns };

  throw new Error('season forecast did not complete');
}

export function createSeasonForecastWorkerApi() {
  let job: Job | null = null;
  return {
    start(request: SeasonForecastWorkerRequest): Update {
      if (job?.status === 'ready' || job?.status === 'running')
        throw new Error('a season forecast is already running');

      job =
        request.kind === 'league-table'
          ? createLeagueSimulation(request.input)
          : createChampionsLeagueForecast(
              restoreChampionsLeagueForecastInput(request.input),
            );
      return job === null ? { status: 'unsupported' } : readJob(job);
    },

    advance(): Update {
      if (job === null) throw new Error('start a season forecast first');
      job.advance(runsPerBatch);
      return readJob(job);
    },
  };
}

export type SeasonForecastWorkerApi = ReturnType<
  typeof createSeasonForecastWorkerApi
>;
