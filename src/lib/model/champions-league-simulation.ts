import {
  createChampionsLeagueFinalSimulation,
  type ChampionsLeagueFinalFixture,
  type ChampionsLeagueFinalMatchInputs,
  type ChampionsLeagueFinalPreparation,
  type ChampionsLeagueFinalSample,
} from './champions-league-final-simulation';
import {
  rankChampionsLeaguePhase,
  type ChampionsLeaguePhaseRanking,
  type ChampionsLeaguePhaseTieBreakContext,
} from './champions-league-phase-ranking';
import {
  createChampionsLeaguePlayOffDraw,
  type OfficialChampionsLeaguePlayOffDraw,
} from './champions-league-play-off-draw';
import {
  createChampionsLeaguePlayOffSimulation,
  type ChampionsLeaguePlayOffMatchInputs,
  type ChampionsLeaguePlayOffSample,
} from './champions-league-play-off-simulation';
import {
  createChampionsLeagueQuarterFinalDraw,
  type OfficialChampionsLeagueQuarterFinalHomeOrder,
} from './champions-league-quarter-final-draw';
import {
  createChampionsLeagueQuarterFinalSimulation,
  type ChampionsLeagueQuarterFinalMatchInputs,
  type ChampionsLeagueQuarterFinalSample,
} from './champions-league-quarter-final-simulation';
import {
  createChampionsLeagueRoundOf16Draw,
  type OfficialChampionsLeagueRoundOf16Draw,
} from './champions-league-round-of-16-draw';
import {
  createChampionsLeagueRoundOf16Simulation,
  type ChampionsLeagueRoundOf16MatchInputs,
  type ChampionsLeagueRoundOf16Sample,
} from './champions-league-round-of-16-simulation';
import {
  createChampionsLeagueSemiFinalDraw,
  type OfficialChampionsLeagueSemiFinalHomeOrder,
} from './champions-league-semi-final-draw';
import {
  createChampionsLeagueSemiFinalSimulation,
  type ChampionsLeagueSemiFinalMatchInputs,
  type ChampionsLeagueSemiFinalSample,
} from './champions-league-semi-final-simulation';
import type { ChampionsLeagueTwoLegPreparation } from './champions-league-two-leg-round';
import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  createSeasonCalendarSampler,
  type SeasonCalendarFixture,
  type SeasonFixtureScore,
} from './season-calendar-sampler';
import { projectSeasonStats, type SeasonStatsBaseline } from './season-stats';
import {
  createSeededRandom,
  SEEDED_RANDOM_ALGORITHM,
  type RandomSeed,
} from './seeded-random';

export const CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM = 'ucl-seeded-season-run-v1';

export type ChampionsLeagueMatchProviders = {
  readonly playOff: (
    draw: Parameters<typeof createChampionsLeaguePlayOffSimulation>[0],
  ) => readonly ChampionsLeaguePlayOffMatchInputs[];
  readonly roundOf16: (
    draw: Parameters<typeof createChampionsLeagueRoundOf16Simulation>[0],
  ) => readonly ChampionsLeagueRoundOf16MatchInputs[];
  readonly quarterFinals: (
    draw: Parameters<typeof createChampionsLeagueQuarterFinalSimulation>[0],
  ) => readonly ChampionsLeagueQuarterFinalMatchInputs[];
  readonly semiFinals: (
    draw: Parameters<typeof createChampionsLeagueSemiFinalSimulation>[0],
  ) => readonly ChampionsLeagueSemiFinalMatchInputs[];
  readonly final: (
    fixture: ChampionsLeagueFinalFixture,
  ) => ChampionsLeagueFinalMatchInputs | null;
};

export type ChampionsLeagueSimulationInput = {
  readonly season: number;
  readonly baseline: readonly Readonly<SeasonStatsBaseline>[];
  readonly fixtures: readonly SeasonCalendarFixture[];
  readonly tieBreakContext?: readonly ChampionsLeaguePhaseTieBreakContext[];
  readonly officialDraws?: {
    readonly playOff?: OfficialChampionsLeaguePlayOffDraw;
    readonly roundOf16?: OfficialChampionsLeagueRoundOf16Draw;
    readonly quarterFinals?: OfficialChampionsLeagueQuarterFinalHomeOrder;
    readonly semiFinals?: OfficialChampionsLeagueSemiFinalHomeOrder;
  };
  readonly sampling: Readonly<PoissonDistributionOptions>;
  /** Deterministic providers scoped to the same data cutoff as the phase inputs. */
  readonly matches: ChampionsLeagueMatchProviders;
};

export type ChampionsLeagueSimulationSample = {
  status: 'complete';
  algorithm: typeof CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM;
  randomAlgorithm: typeof SEEDED_RANDOM_ALGORITHM;
  seed: RandomSeed;
  /** Union bound for this run, excluding numeric/RNG resolution and model error. */
  tailUpperBound: number;
  leaguePhase: {
    ranking: ChampionsLeaguePhaseRanking;
    scores: SeasonFixtureScore[];
  };
  playOff: ChampionsLeaguePlayOffSample;
  roundOf16: ChampionsLeagueRoundOf16Sample;
  quarterFinals: ChampionsLeagueQuarterFinalSample;
  semiFinals: ChampionsLeagueSemiFinalSample;
  final: ChampionsLeagueFinalSample;
};

export type ChampionsLeagueSimulationUnavailable =
  | {
      status: 'unavailable';
      stage: 'league-phase';
      reason:
        | 'calendar-sampler-unavailable'
        | 'invalid-league-phase'
        | 'unsupported-bracket';
    }
  | {
      status: 'unavailable';
      stage: 'league-phase';
      reason: 'unresolved-seeding';
      groups: ChampionsLeaguePhaseRanking['groups'];
    }
  | (Extract<
      ChampionsLeagueTwoLegPreparation<
        { side: 'silver' | 'blue'; seededPairStart?: number },
        unknown
      >,
      { status: 'unavailable' }
    > & { stage: 'play-off' | 'round-of-16' | 'quarter-finals' | 'semi-finals' })
  | (Extract<ChampionsLeagueFinalPreparation, { status: 'unavailable' }> & {
      stage: 'final';
    });

/**
 * Prepare one Champions League scenario from a cutoff-consistent calendar
 * and optional published draws. The caller authenticates those inputs.
 * Providers supply the match inputs for the actual simulated or recorded pairs
 * and receive independent copies of the fixtures. Replaying a seed requires
 * the same input snapshot, implementation versions and deterministic providers.
 *
 * Sample the league phase, draws and matches in stage order from one random
 * stream. An unresolved seeding position or missing match context stops the
 * run with diagnostics for the affected stage.
 */
export function createChampionsLeagueSimulation(
  input: ChampionsLeagueSimulationInput,
) {
  const { matches, ...data } = input;
  const snapshot = structuredClone(data);
  const providers = { ...matches };
  const {
    season,
    baseline,
    fixtures,
    sampling,
    tieBreakContext,
    officialDraws = {},
  } = snapshot;
  if (
    Object.values(officialDraws).some((draw) => draw !== undefined) &&
    fixtures.some((fixture) => fixture.kind === 'forecast')
  )
    throw new RangeError(
      'published knockout draws require a fully observed league phase',
    );

  const calendar = createSeasonCalendarSampler(fixtures, sampling);
  return {
    sample(
      seed: RandomSeed,
    ): ChampionsLeagueSimulationSample | ChampionsLeagueSimulationUnavailable {
      const runSeed: RandomSeed = [...seed];
      const random = createSeededRandom(runSeed);
      if (calendar === null)
        return {
          status: 'unavailable',
          stage: 'league-phase',
          reason: 'calendar-sampler-unavailable',
        };

      const scores = calendar.sample(random);
      const rows = projectSeasonStats(baseline, scores);
      const ranking =
        rows === null
          ? null
          : rankChampionsLeaguePhase(rows, scores, season, tieBreakContext);
      if (ranking === null)
        return {
          status: 'unavailable',
          stage: 'league-phase',
          reason: 'invalid-league-phase',
        };

      const unresolved = ranking.groups.filter(
        ({ from, to }) => from <= 24 && to > from,
      );
      if (unresolved.length > 0)
        return {
          status: 'unavailable',
          stage: 'league-phase',
          reason: 'unresolved-seeding',
          groups: unresolved,
        };

      const playOffDraw = createChampionsLeaguePlayOffDraw(season, ranking.groups);
      if (playOffDraw === null)
        return {
          status: 'unavailable',
          stage: 'league-phase',
          reason: 'unsupported-bracket',
        };
      const playOffPairs =
        officialDraws.playOff === undefined
          ? playOffDraw.sample(random)
          : playOffDraw.fromOfficial(officialDraws.playOff);
      const playOffPreparation = createChampionsLeaguePlayOffSimulation(
        playOffPairs,
        providers.playOff(structuredClone(playOffPairs)),
        sampling,
      );
      if (playOffPreparation.status === 'unavailable')
        return { ...playOffPreparation, stage: 'play-off' };
      const playOff = playOffPreparation.sample(random);

      const roundOf16Draw = createChampionsLeagueRoundOf16Draw(
        ranking.groups,
        playOff,
      );
      if (roundOf16Draw === null)
        return {
          status: 'unavailable',
          stage: 'league-phase',
          reason: 'unsupported-bracket',
        };
      const roundOf16Pairs =
        officialDraws.roundOf16 === undefined
          ? roundOf16Draw.sample(random)
          : roundOf16Draw.fromOfficial(officialDraws.roundOf16);
      const roundOf16Preparation = createChampionsLeagueRoundOf16Simulation(
        roundOf16Pairs,
        providers.roundOf16(structuredClone(roundOf16Pairs)),
        sampling,
      );
      if (roundOf16Preparation.status === 'unavailable')
        return { ...roundOf16Preparation, stage: 'round-of-16' };
      const roundOf16 = roundOf16Preparation.sample(random);

      const quarterFinalDraw = createChampionsLeagueQuarterFinalDraw(roundOf16);
      const quarterFinalPairs =
        officialDraws.quarterFinals === undefined
          ? quarterFinalDraw.sample(random)
          : quarterFinalDraw.withOfficialHomeOrder(officialDraws.quarterFinals);
      const quarterFinalPreparation = createChampionsLeagueQuarterFinalSimulation(
        quarterFinalPairs,
        providers.quarterFinals(structuredClone(quarterFinalPairs)),
        sampling,
      );
      if (quarterFinalPreparation.status === 'unavailable')
        return { ...quarterFinalPreparation, stage: 'quarter-finals' };
      const quarterFinals = quarterFinalPreparation.sample(random);

      const semiFinalDraw = createChampionsLeagueSemiFinalDraw(quarterFinals);
      const semiFinalPairs =
        officialDraws.semiFinals === undefined
          ? semiFinalDraw.sample(random)
          : semiFinalDraw.withOfficialHomeOrder(officialDraws.semiFinals);
      const semiFinalPreparation = createChampionsLeagueSemiFinalSimulation(
        semiFinalPairs,
        providers.semiFinals(structuredClone(semiFinalPairs)),
        sampling,
      );
      if (semiFinalPreparation.status === 'unavailable')
        return { ...semiFinalPreparation, stage: 'semi-finals' };
      const semiFinals = semiFinalPreparation.sample(random);

      const finalSimulation = createChampionsLeagueFinalSimulation(semiFinals);
      const finalPreparation = finalSimulation.prepare(
        providers.final(finalSimulation.fixture),
        sampling,
      );
      if (finalPreparation.status === 'unavailable')
        return { ...finalPreparation, stage: 'final' };

      return {
        status: 'complete',
        algorithm: CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
        randomAlgorithm: SEEDED_RANDOM_ALGORITHM,
        seed: runSeed,
        tailUpperBound: Math.min(
          1,
          calendar.tailUpperBound +
            playOffPreparation.tailUpperBound +
            roundOf16Preparation.tailUpperBound +
            quarterFinalPreparation.tailUpperBound +
            semiFinalPreparation.tailUpperBound +
            finalPreparation.tailUpperBound,
        ),
        leaguePhase: { ranking, scores },
        playOff,
        roundOf16,
        quarterFinals,
        semiFinals,
        final: finalPreparation.sample(random),
      };
    },
  };
}
