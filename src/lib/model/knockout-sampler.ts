import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  createPoissonScoreSampler,
  type PoissonScoreSampler,
} from './poisson-score-sampler';
import {
  createSeasonCalendarSampler,
  type SeasonCalendarFixture,
} from './season-calendar-sampler';

export const KNOCKOUT_SAMPLING_ALGORITHM =
  'aggregate-no-away-goals-conditional-extra-time-penalties-v1';

export type KnockoutLegInput = { readonly leg: 1 | 2 } & (
  | Omit<Extract<SeasonCalendarFixture, { kind: 'known-result' }>, 'id'>
  | Omit<Extract<SeasonCalendarFixture, { kind: 'forecast' }>, 'id'>
);

export type KnockoutExtraTimeInput =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'known-result';
      readonly homeGoals30: number;
      readonly awayGoals30: number;
    }
  | {
      readonly kind: 'forecast';
      /** Explicit rates for the entire extra-time period, at the last leg's venue. */
      readonly homeRate30: number;
      readonly awayRate30: number;
    };

export type KnockoutPenaltiesInput =
  | { readonly kind: 'known-result'; readonly winnerTeamId: number }
  | {
      readonly kind: 'forecast';
      /** Chance of firstTeamId winning; not the first kick or the home side. */
      readonly firstTeamWinProbability: number;
    };

export type KnockoutSamplingInput = {
  readonly firstTeamId: number;
  readonly secondTeamId: number;
  readonly legs: readonly KnockoutLegInput[];
  readonly extraTime: KnockoutExtraTimeInput;
  readonly penalties: KnockoutPenaltiesInput | null;
  readonly sampling: Readonly<PoissonDistributionOptions>;
};

type GoalTotals = { first: number; second: number };

export type KnockoutLegScore = {
  leg: 1 | 2;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals90: number;
  awayGoals90: number;
  source: 'known-result' | 'simulated';
};

export type SampledKnockout = {
  algorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  winnerTeamId: number;
  loserTeamId: number;
  method: 'regulation-goals' | 'aggregate-goals' | 'extra-time-goals' | 'penalties';
  aggregateGoals90: GoalTotals;
  aggregateGoalsAfterExtraTime: GoalTotals | null;
  legs: KnockoutLegScore[];
  extraTime: {
    homeTeamId: number;
    awayTeamId: number;
    homeGoals30: number;
    awayGoals30: number;
    source: 'known-result' | 'simulated';
  } | null;
  shootout: { winnerTeamId: number; source: 'known-result' | 'simulated' } | null;
};

export type KnockoutSampler = {
  readonly algorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  readonly calendarSamplingAlgorithm: string;
  readonly scoreSamplingAlgorithm: string;
  readonly fixedLegCount: number;
  readonly simulatedLegCount: number;
  readonly extraTimePolicy: 'none' | 'extra-time-then-penalties';
  /** Union bound per series, excluding round-off, RNG resolution and model error. */
  readonly tailUpperBound: number;
  readonly sample: (random: () => number) => SampledKnockout;
};

function addGoals(
  totals: GoalTotals,
  firstAtHome: boolean,
  home: number,
  away: number,
): GoalTotals {
  const first = totals.first + (firstAtHome ? home : away);
  const second = totals.second + (firstAtHome ? away : home);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second))
    throw new RangeError('aggregate goals exceed the safe integer range');
  return { first, second };
}

/**
 * Prepare one fully specified one/two-leg knockout scenario, with no away-goals
 * weighting. Two legs must reverse the home order. The caller supplies the
 * format, authentic cutoff-safe completed results, goal rates and an explicit
 * shootout probability. This function neither selects official pairs/venues nor
 * infers competition rules, extra-time rates or penalty chances.
 * Future leg scores use the calendar sampler in leg order; known legs use no RNG.
 * Extra time is played only after a tied regulation aggregate, at the last leg's
 * venue. Its supplied rates cover all 30 minutes; there is no automatic scaling.
 * A tied final total uses one Bernoulli draw, even for probabilities zero/one.
 * Known extra time requires known tied regulation scores; a known shootout
 * requires known tied final totals. Never apply observed conditional outcomes
 * to resampled preceding scores. Return null for missing required penalty
 * context or an unavailable reachable score sampler. Do not drop/resample ties.
 * Valid unused forecast settings are validated but consume no draws or tail
 * budget. The extra-time tail bound is conservatively included whenever a
 * regulation tie may occur. Invalid data/options/random values and unsafe
 * arithmetic throw RangeError; a failed sample may have consumed RNG values.
 * Inputs are copied; every successful sample returns independent result objects.
 * This is a fixed-rate independent-Poisson scenario model, not a calibrated
 * prediction of extra time, shootout kicks or future format/venue decisions.
 */
export function createKnockoutSampler(
  input: KnockoutSamplingInput,
): KnockoutSampler | null {
  const { firstTeamId, secondTeamId } = input;
  if (
    !Number.isSafeInteger(firstTeamId) ||
    firstTeamId <= 0 ||
    !Number.isSafeInteger(secondTeamId) ||
    secondTeamId <= 0 ||
    firstTeamId === secondTeamId
  )
    throw new RangeError('knockout requires two distinct positive safe team IDs');
  if (input.legs.length !== 1 && input.legs.length !== 2)
    throw new RangeError('knockout requires one or two scheduled legs');

  const prepared = Array.from(input.legs, (leg): SeasonCalendarFixture => {
    if (
      leg === undefined ||
      leg === null ||
      (leg.leg !== 1 && leg.leg !== 2) ||
      ![firstTeamId, secondTeamId].includes(leg.homeTeamId) ||
      ![firstTeamId, secondTeamId].includes(leg.awayTeamId) ||
      leg.homeTeamId === leg.awayTeamId
    )
      throw new RangeError('legs require valid ordinals and the selected pair');
    const identity = {
      id: leg.leg,
      homeTeamId: leg.homeTeamId,
      awayTeamId: leg.awayTeamId,
    };
    if (leg.kind === 'known-result')
      return {
        ...identity,
        kind: 'known-result',
        homeGoals90: leg.homeGoals90,
        awayGoals90: leg.awayGoals90,
      };
    if (leg.kind === 'forecast')
      return {
        ...identity,
        kind: 'forecast',
        homeRate90: leg.homeRate90,
        awayRate90: leg.awayRate90,
      };
    throw new RangeError('leg kind must be known-result or forecast');
  }).sort((left, right) => left.id - right.id);
  if (
    prepared[0]!.id !== 1 ||
    (prepared.length === 2 &&
      (prepared[1]!.id !== 2 ||
        prepared[0]!.homeTeamId !== prepared[1]!.awayTeamId ||
        prepared[0]!.awayTeamId !== prepared[1]!.homeTeamId))
  )
    throw new RangeError('legs must be 1 or 1/2 with reversed home order');

  const calendar = createSeasonCalendarSampler(prepared, input.sampling);
  const futureLegs = prepared.some((leg) => leg.kind === 'forecast');
  let knownTotals: GoalTotals = { first: 0, second: 0 };
  for (const leg of prepared) {
    if (leg.kind === 'known-result')
      knownTotals = addGoals(
        knownTotals,
        leg.homeTeamId === firstTeamId,
        leg.homeGoals90,
        leg.awayGoals90,
      );
  }
  const mayTie90 = futureLegs || knownTotals.first === knownTotals.second;
  const last = prepared[prepared.length - 1]!;
  let extraTime: KnockoutExtraTimeInput;
  let extraTimeSampler: PoissonScoreSampler | null = null;
  if (input.extraTime.kind === 'none') {
    extraTime = { kind: 'none' };
  } else if (input.extraTime.kind === 'known-result') {
    const { homeGoals30, awayGoals30 } = input.extraTime;
    if (
      !Number.isSafeInteger(homeGoals30) ||
      homeGoals30 < 0 ||
      !Number.isSafeInteger(awayGoals30) ||
      awayGoals30 < 0 ||
      futureLegs ||
      !mayTie90
    )
      throw new RangeError('known extra time requires known tied regulation scores');
    extraTime = { kind: 'known-result', homeGoals30, awayGoals30 };
    knownTotals = addGoals(
      knownTotals,
      last.homeTeamId === firstTeamId,
      homeGoals30,
      awayGoals30,
    );
  } else if (input.extraTime.kind === 'forecast') {
    const { homeRate30, awayRate30 } = input.extraTime;
    extraTime = { kind: 'forecast', homeRate30, awayRate30 };
    extraTimeSampler = createPoissonScoreSampler(
      homeRate30,
      awayRate30,
      input.sampling,
    );
  } else {
    throw new RangeError('extra time must be none, known-result or forecast');
  }

  let penalties: KnockoutPenaltiesInput | null = null;
  if (input.penalties !== null) {
    if (input.penalties.kind === 'forecast') {
      const { firstTeamWinProbability } = input.penalties;
      if (
        !Number.isFinite(firstTeamWinProbability) ||
        firstTeamWinProbability < 0 ||
        firstTeamWinProbability > 1
      )
        throw new RangeError('shootout chance must be finite and in [0, 1]');
      penalties = { kind: 'forecast', firstTeamWinProbability };
    } else if (input.penalties.kind === 'known-result') {
      const { winnerTeamId } = input.penalties;
      if (
        ![firstTeamId, secondTeamId].includes(winnerTeamId) ||
        futureLegs ||
        !mayTie90 ||
        extraTime.kind === 'forecast' ||
        knownTotals.first !== knownTotals.second
      )
        throw new RangeError('known shootout requires known tied final totals');
      penalties = { kind: 'known-result', winnerTeamId };
    } else {
      throw new RangeError('penalties must be known-result, forecast or null');
    }
  }
  const mayNeedPenalties =
    mayTie90 &&
    (extraTime.kind !== 'known-result' || knownTotals.first === knownTotals.second);
  if (
    calendar === null ||
    (mayTie90 && extraTime.kind === 'forecast' && extraTimeSampler === null) ||
    (mayNeedPenalties && penalties === null)
  )
    return null;

  const extraTimePolicy =
    extraTime.kind === 'none' ? 'none' : 'extra-time-then-penalties';
  return {
    algorithm: KNOCKOUT_SAMPLING_ALGORITHM,
    calendarSamplingAlgorithm: calendar.algorithm,
    scoreSamplingAlgorithm: calendar.scoreSamplingAlgorithm,
    fixedLegCount: calendar.fixedFixtureCount,
    simulatedLegCount: calendar.simulatedFixtureCount,
    extraTimePolicy,
    tailUpperBound: Math.min(
      1,
      calendar.tailUpperBound +
        (mayTie90 ? (extraTimeSampler?.tailUpperBound ?? 0) : 0),
    ),
    sample(random) {
      const legs = calendar
        .sample(random)
        .map(({ id, ...score }): KnockoutLegScore => ({
          leg: id as 1 | 2,
          ...score,
        }));
      let totals: GoalTotals = { first: 0, second: 0 };
      for (const leg of legs)
        totals = addGoals(
          totals,
          leg.homeTeamId === firstTeamId,
          leg.homeGoals90,
          leg.awayGoals90,
        );
      const aggregateGoals90 = { ...totals };
      let sampledExtraTime: SampledKnockout['extraTime'] = null;
      let aggregateGoalsAfterExtraTime: GoalTotals | null = null;
      let shootout: SampledKnockout['shootout'] = null;
      let method: SampledKnockout['method'] =
        legs.length === 1 ? 'regulation-goals' : 'aggregate-goals';
      if (totals.first === totals.second && extraTime.kind !== 'none') {
        const score =
          extraTime.kind === 'known-result'
            ? {
                homeGoals: extraTime.homeGoals30,
                awayGoals: extraTime.awayGoals30,
              }
            : extraTimeSampler!.sample(random);
        sampledExtraTime = {
          homeTeamId: last.homeTeamId,
          awayTeamId: last.awayTeamId,
          homeGoals30: score.homeGoals,
          awayGoals30: score.awayGoals,
          source: extraTime.kind === 'known-result' ? 'known-result' : 'simulated',
        };
        totals = addGoals(
          totals,
          last.homeTeamId === firstTeamId,
          score.homeGoals,
          score.awayGoals,
        );
        aggregateGoalsAfterExtraTime = { ...totals };
        method = 'extra-time-goals';
      }
      let winnerTeamId = totals.first > totals.second ? firstTeamId : secondTeamId;
      if (totals.first === totals.second) {
        if (penalties!.kind === 'known-result') {
          winnerTeamId = penalties!.winnerTeamId;
          shootout = { winnerTeamId, source: 'known-result' };
        } else {
          const uniform = random();
          if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1)
            throw new RangeError('random values must be finite and in [0, 1)');
          winnerTeamId =
            uniform < penalties!.firstTeamWinProbability
              ? firstTeamId
              : secondTeamId;
          shootout = { winnerTeamId, source: 'simulated' };
        }
        method = 'penalties';
      }
      return {
        algorithm: KNOCKOUT_SAMPLING_ALGORITHM,
        winnerTeamId,
        loserTeamId: winnerTeamId === firstTeamId ? secondTeamId : firstTeamId,
        method,
        aggregateGoals90,
        aggregateGoalsAfterExtraTime,
        legs,
        extraTime: sampledExtraTime,
        shootout,
      };
    },
  };
}
