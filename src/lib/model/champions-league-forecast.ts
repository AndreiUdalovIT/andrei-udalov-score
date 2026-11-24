import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
  createChampionsLeagueSimulation,
  type ChampionsLeagueSimulationInput,
  type ChampionsLeagueSimulationSample,
  type ChampionsLeagueSimulationUnavailable,
} from './champions-league-simulation';
import type { LeagueSimulation, LeagueSimulationInput } from './league-simulation';
import {
  createSeededRandom,
  SEEDED_RANDOM_ALGORITHM,
  type RandomSeed,
} from './seeded-random';

export const CHAMPIONS_LEAGUE_FORECAST_ALGORITHM = 'ucl-stage-frequencies-v1';

const events = [
  'playOff',
  'directRoundOf16',
  'roundOf16',
  'quarterFinals',
  'semiFinals',
  'final',
  'champion',
] as const;

type Event = (typeof events)[number];
type Frequencies = Record<Event, { count: number; probability: number }>;

export type ChampionsLeagueForecastInput = ChampionsLeagueSimulationInput &
  Pick<LeagueSimulationInput, 'seed' | 'runs' | 'modelVersion' | 'dataCutoffMs'>;

export type ChampionsLeagueForecastResult = {
  algorithm: typeof CHAMPIONS_LEAGUE_FORECAST_ALGORITHM;
  inputSnapshot: Omit<ChampionsLeagueForecastInput, 'matches'>;
  versions: {
    random: typeof SEEDED_RANDOM_ALGORITHM;
    simulation: typeof CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM;
  };
  /** Truncated Poisson mass bounds, excluding numeric/RNG resolution and model error. */
  samplingBounds: { perRun: number; allRuns: number };
  teams: { teamId: number; events: Frequencies }[];
};

export type ChampionsLeagueForecastUnavailability =
  ChampionsLeagueSimulationUnavailable & {
    run: number;
    seed: RandomSeed;
  };

export type ChampionsLeagueForecast = Pick<
  LeagueSimulation,
  'status' | 'completedRuns' | 'advance' | 'cancel'
> & {
  readonly unavailability: ChampionsLeagueForecastUnavailability | null;
  readonly result: () => ChampionsLeagueForecastResult | null;
};

/** Use four successive u53 draws' high 32 bits; reject the all-zero engine state. */
function nextRunSeed(random: () => number): RandomSeed {
  let seed: RandomSeed;
  do {
    seed = [
      Math.floor(random() * 2 ** 32),
      Math.floor(random() * 2 ** 32),
      Math.floor(random() * 2 ** 32),
      Math.floor(random() * 2 ** 32),
    ];
  } while (seed.every((word) => word === 0));
  return seed;
}

/**
 * Accumulate stage reach as frequencies over a fixed number of complete runs.
 * The same seed, snapshot and deterministic match providers reproduce the
 * sequence for any batch size. Providers supply cutoff-scoped match data and
 * rates for the specified model version. The snapshot contains serializable
 * inputs; replay also requires those providers.
 *
 * A blocked scenario withholds the forecast and retains its run number and
 * seed. Cancellation can stop between scenarios, and leaves any in-progress
 * scenario uncounted. Fresh results are returned in team ID order.
 */
export function createChampionsLeagueForecast(
  input: ChampionsLeagueForecastInput,
): ChampionsLeagueForecast | null {
  const { matches, ...data } = input;
  const snapshot = structuredClone(data);
  const { season, runs, seed, modelVersion, dataCutoffMs, baseline } = snapshot;
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  if (!Number.isSafeInteger(runs) || runs <= 0)
    throw new RangeError('target runs must be a positive safe integer');
  if (
    typeof modelVersion !== 'string' ||
    modelVersion.trim().length === 0 ||
    !Number.isSafeInteger(dataCutoffMs) ||
    !Number.isFinite(new Date(dataCutoffMs).getTime())
  )
    throw new RangeError(
      'forecast requires a model version and valid UTC cutoff milliseconds',
    );

  const random = createSeededRandom(seed);
  const config = getCompetitionSeasonConfig('CL', season);
  if (config?.format !== 'league-phase') return null;
  const teamIds = baseline
    .map(({ teamId }) => teamId)
    .sort((left, right) => left - right);
  if (
    teamIds.length !== config.teamCount ||
    new Set(teamIds).size !== config.teamCount ||
    teamIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new RangeError(
      'forecast requires the complete roster of unique positive team IDs',
    );

  const simulation = createChampionsLeagueSimulation({ ...snapshot, matches });
  const counts = new Map(
    teamIds.map((id) => [
      id,
      Object.fromEntries(events.map((event) => [event, 0])) as Record<Event, number>,
    ]),
  );
  let status: ChampionsLeagueForecast['status'] = 'ready';
  let completedRuns = 0;
  let unavailability: ChampionsLeagueForecastUnavailability | null = null;
  let perRun = 0;
  let allRuns = 0;
  let advancing = false;

  function active() {
    return status === 'ready' || status === 'running';
  }

  function count(event: Event, ...teamIds: number[]) {
    for (const id of teamIds) counts.get(id)![event] += 1;
  }

  function record(sample: ChampionsLeagueSimulationSample) {
    for (const { tie } of sample.playOff.ties)
      count('playOff', tie.seeded.teamId, tie.unseeded.teamId);
    for (const { tie } of sample.roundOf16.ties) {
      count('directRoundOf16', tie.seeded.teamId);
      count('roundOf16', tie.seeded.teamId, tie.playOffWinner.club.teamId);
    }
    for (const { tie } of sample.quarterFinals.ties)
      count('quarterFinals', tie.first.club.teamId, tie.second.club.teamId);
    for (const { tie } of sample.semiFinals.ties)
      count('semiFinals', tie.first.club.teamId, tie.second.club.teamId);
    count(
      'final',
      sample.final.fixture.silver.club.teamId,
      sample.final.fixture.blue.club.teamId,
    );
    count('champion', sample.final.result.winnerTeamId);
    perRun = Math.max(perRun, sample.tailUpperBound);
    allRuns = Math.min(1, allRuns + sample.tailUpperBound);
    completedRuns += 1;
  }

  return {
    get status() {
      return status;
    },
    get completedRuns() {
      return completedRuns;
    },
    get unavailability() {
      return structuredClone(unavailability);
    },
    advance(maxRuns = 1) {
      if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0)
        throw new RangeError('batch size must be a positive safe integer');
      if (!active()) return;
      if (advancing)
        throw new RangeError('cannot advance a forecast inside an active batch');

      advancing = true;
      status = 'running';
      const limit = Math.min(maxRuns, runs - completedRuns);
      try {
        for (let index = 0; index < limit; index += 1) {
          const runSeed = nextRunSeed(random);
          const sample = simulation.sample(runSeed);
          if (!active()) return;
          if (sample.status === 'unavailable') {
            unavailability = { ...sample, run: completedRuns + 1, seed: runSeed };
            status = 'unavailable';
            return;
          }
          record(sample);
        }
        if (completedRuns === runs) status = 'complete';
      } catch (error) {
        status = 'failed';
        throw error;
      } finally {
        advancing = false;
      }
    },
    cancel() {
      if (active()) status = 'cancelled';
    },
    result() {
      if (status !== 'complete') return null;
      return {
        algorithm: CHAMPIONS_LEAGUE_FORECAST_ALGORITHM,
        inputSnapshot: structuredClone(snapshot),
        versions: {
          random: SEEDED_RANDOM_ALGORITHM,
          simulation: CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
        },
        samplingBounds: { perRun, allRuns },
        teams: Array.from(counts, ([teamId, teamCounts]) => ({
          teamId,
          events: Object.fromEntries(
            events.map((event) => [
              event,
              { count: teamCounts[event], probability: teamCounts[event] / runs },
            ]),
          ) as Frequencies,
        })),
      };
    },
  };
}
