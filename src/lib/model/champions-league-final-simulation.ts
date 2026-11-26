import type { ChampionsLeagueSemiFinalTie } from './champions-league-semi-final-draw';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM,
  copyChampionsLeagueSemiFinalDraw,
  type ChampionsLeagueSemiFinalSample,
} from './champions-league-semi-final-simulation';
import {
  createKnockoutSampler,
  KNOCKOUT_SAMPLING_ALGORITHM,
  type KnockoutExtraTimeInput,
  type KnockoutLegInput,
  type KnockoutPenaltiesInput,
  type SampledKnockout,
} from './knockout-sampler';
import type { PoissonDistributionOptions } from './poisson-distribution';

export const CHAMPIONS_LEAGUE_FINAL_SIMULATION_ALGORITHM =
  'ucl-neutral-single-match-final-v1';

type Finalist = {
  club: ChampionsLeagueSemiFinalTie['first']['club'];
  source: 'observed' | 'simulated';
};

export type ChampionsLeagueFinalFixture = {
  season: number;
  source: 'official' | 'simulated';
  venue: 'neutral';
  /** Administrative designation under Article 19.05. */
  nominalHomeTeamId: number;
  silver: Finalist;
  blue: Finalist;
  semiFinalDraw: ChampionsLeagueSemiFinalSample['draw'];
};

export type ChampionsLeagueFinalMatchInputs = {
  readonly silverTeamId: number;
  readonly blueTeamId: number;
  readonly regulation:
    | {
        readonly kind: 'known-result';
        readonly silverGoals90: number;
        readonly blueGoals90: number;
      }
    | {
        readonly kind: 'forecast';
        readonly silverNeutralRate90: number;
        readonly blueNeutralRate90: number;
      };
  readonly extraTime:
    | {
        readonly kind: 'known-result';
        readonly silverGoals30: number;
        readonly blueGoals30: number;
      }
    | {
        readonly kind: 'forecast';
        readonly silverNeutralRate30: number;
        readonly blueNeutralRate30: number;
      }
    | null;
  /** firstTeamWinProbability refers to the silver-side finalist. */
  readonly penalties: KnockoutPenaltiesInput | null;
};

export type ChampionsLeagueFinalSample = {
  algorithm: typeof CHAMPIONS_LEAGUE_FINAL_SIMULATION_ALGORITHM;
  fixture: ChampionsLeagueFinalFixture;
  result: SampledKnockout;
};

export type ChampionsLeagueFinalPreparation =
  | {
      readonly status: 'ready';
      readonly tailUpperBound: number;
      readonly sample: (random: () => number) => ChampionsLeagueFinalSample;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'missing-match-inputs'
        | 'missing-extra-time'
        | 'knockout-sampler-unavailable';
    };

/**
 * Pair the silver and blue semi-final winners under Articles 19.05 and 22.
 * The silver side is nominally home. Supply explicit neutral-site goal rates
 * for each period and a shootout probability when needed. No venue adjustment
 * is inferred from the administrative ordering. Observations require both
 * finalists to be observed. The caller authenticates scores and the cutoff.
 */
export function createChampionsLeagueFinalSimulation(
  semiFinals: ChampionsLeagueSemiFinalSample,
) {
  if (
    semiFinals.algorithm !== CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM ||
    semiFinals.knockoutAlgorithm !== KNOCKOUT_SAMPLING_ALGORITHM
  )
    throw new RangeError('the final requires a supported semi-final sample');

  const { ties, ...semiFinalDraw } = copyChampionsLeagueSemiFinalDraw({
    ...semiFinals.draw,
    ties: Array.from(semiFinals.ties, (entry) => {
      if (entry == null)
        throw new RangeError('each semi-final side requires a result');
      return entry.tie;
    }),
  });

  function finalist(tie: ChampionsLeagueSemiFinalTie): Finalist {
    const result = semiFinals.ties.find(
      ({ tie: original }) => original.side === tie.side,
    )?.result;
    if (
      result?.algorithm !== KNOCKOUT_SAMPLING_ALGORITHM ||
      result.legs.length !== 2 ||
      result.legs[0]?.leg !== 1 ||
      result.legs[1]?.leg !== 2
    )
      throw new RangeError(
        'each semi-final side requires a supported two-leg result',
      );
    const clubs = [tie.first.club, tie.second.club];
    const winner = clubs.find(({ teamId }) => teamId === result.winnerTeamId);
    const loser = clubs.find(({ teamId }) => teamId === result.loserTeamId);
    if (winner === undefined || loser === undefined || winner === loser)
      throw new RangeError('the semi-final winner and loser must belong to the tie');

    const observed =
      semiFinalDraw.source === 'official' &&
      result.legs.every((leg) => leg.source === 'known-result') &&
      (result.extraTime === null || result.extraTime.source === 'known-result') &&
      (result.shootout === null || result.shootout.source === 'known-result');
    return { club: { ...winner }, source: observed ? 'observed' : 'simulated' };
  }

  const silver = finalist(ties[0]!);
  const blue = finalist(ties[1]!);

  const fixture: ChampionsLeagueFinalFixture = {
    season: semiFinalDraw.season,
    source:
      silver.source === 'observed' && blue.source === 'observed'
        ? 'official'
        : 'simulated',
    venue: 'neutral',
    nominalHomeTeamId: silver.club.teamId,
    silver,
    blue,
    semiFinalDraw,
  };

  return {
    fixture: structuredClone(fixture),

    prepare(
      match: ChampionsLeagueFinalMatchInputs | null,
      sampling: Readonly<PoissonDistributionOptions>,
    ): ChampionsLeagueFinalPreparation {
      if (match === null)
        return { status: 'unavailable', reason: 'missing-match-inputs' };
      const { silverTeamId, blueTeamId, regulation, extraTime, penalties } = match;
      if (
        silverTeamId !== fixture.silver.club.teamId ||
        blueTeamId !== fixture.blue.club.teamId
      )
        throw new RangeError(
          'final match inputs must use the silver and blue finalists in order',
        );

      if (
        fixture.source === 'simulated' &&
        (regulation.kind === 'known-result' ||
          extraTime?.kind === 'known-result' ||
          penalties?.kind === 'known-result')
      )
        throw new RangeError('observed final results require observed finalists');

      const nominalSides = {
        leg: 1,
        homeTeamId: silverTeamId,
        awayTeamId: blueTeamId,
      } as const;
      const leg: KnockoutLegInput =
        regulation.kind === 'known-result'
          ? {
              ...nominalSides,
              kind: regulation.kind,
              homeGoals90: regulation.silverGoals90,
              awayGoals90: regulation.blueGoals90,
            }
          : {
              ...nominalSides,
              kind: regulation.kind,
              homeRate90: regulation.silverNeutralRate90,
              awayRate90: regulation.blueNeutralRate90,
            };
      const extraTimeInput: KnockoutExtraTimeInput =
        extraTime === null
          ? { kind: 'none' }
          : extraTime.kind === 'known-result'
            ? {
                kind: extraTime.kind,
                homeGoals30: extraTime.silverGoals30,
                awayGoals30: extraTime.blueGoals30,
              }
            : {
                kind: extraTime.kind,
                homeRate30: extraTime.silverNeutralRate30,
                awayRate30: extraTime.blueNeutralRate30,
              };

      const sampler = createKnockoutSampler({
        firstTeamId: silverTeamId,
        secondTeamId: blueTeamId,
        legs: [leg],
        extraTime: extraTimeInput,
        penalties,
        sampling,
      });
      if (
        extraTime === null &&
        (regulation.kind === 'forecast' ||
          regulation.silverGoals90 === regulation.blueGoals90)
      )
        return { status: 'unavailable', reason: 'missing-extra-time' };
      if (sampler === null)
        return { status: 'unavailable', reason: 'knockout-sampler-unavailable' };

      return {
        status: 'ready',
        tailUpperBound: sampler.tailUpperBound,
        sample(random) {
          return {
            algorithm: CHAMPIONS_LEAGUE_FINAL_SIMULATION_ALGORITHM,
            fixture: structuredClone(fixture),
            result: sampler.sample(random),
          };
        },
      };
    },
  };
}
