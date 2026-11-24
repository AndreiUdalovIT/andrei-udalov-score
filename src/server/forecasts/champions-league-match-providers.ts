import 'server-only';

import type {
  ChampionsLeagueFinalFixture,
  ChampionsLeagueFinalMatchInputs,
} from '@/lib/model/champions-league-final-simulation';
import type { ChampionsLeagueMatchProviders } from '@/lib/model/champions-league-simulation';
import type { ChampionsLeagueTwoLegMatchInputs } from '@/lib/model/champions-league-two-leg-round';
import type {
  KnockoutExtraTimeInput,
  KnockoutLegInput,
  KnockoutPenaltiesInput,
} from '@/lib/model/knockout-sampler';
import { isPrematchFixture } from '@/lib/model/prediction-eligibility';

import type { ChampionsLeagueKnockoutObservation } from './load-knockout-observations';
import { createChampionsLeagueKnockoutFixtureLookup } from './match-knockout-fixtures';

type Observation = ChampionsLeagueKnockoutObservation;
type ObservedScore = NonNullable<Observation['result']>;
type TwoLegStage = Exclude<Observation['stage'], 'FINAL'>;
type Draw = Pick<ChampionsLeagueFinalFixture, 'season' | 'source'>;
type TeamPair = Pick<
  ChampionsLeagueTwoLegMatchInputs,
  'firstTeamId' | 'secondTeamId'
>;
type DrawnTie = TeamPair & { readonly firstLegHomeTeamId: number | null };
type LeagueLegRateRequest = TeamPair &
  Pick<KnockoutLegInput, 'leg' | 'homeTeamId' | 'awayTeamId'> & {
    readonly stage: TwoLegStage;
  };

type LegForecast = Pick<
  Extract<KnockoutLegInput, { kind: 'forecast' }>,
  'homeRate90' | 'awayRate90'
> & {
  /** Used only on the return leg. Rates cover all 30 minutes. */
  readonly extraTime: Extract<KnockoutExtraTimeInput, { kind: 'forecast' }> | null;
  /** Forecast chance refers to the pair's firstTeamId. */
  readonly penalties: Extract<KnockoutPenaltiesInput, { kind: 'forecast' }> | null;
};

type FinalForecast = {
  readonly regulation: Extract<
    ChampionsLeagueFinalMatchInputs['regulation'],
    { kind: 'forecast' }
  >;
  readonly extraTime: Extract<
    ChampionsLeagueFinalMatchInputs['extraTime'],
    { kind: 'forecast' }
  > | null;
  /** Forecast chance refers to the silver-side club. */
  readonly penalties: LegForecast['penalties'];
};

type PreparedLeg =
  | (Extract<KnockoutLegInput, { kind: 'known-result' }> &
      Pick<ObservedScore, 'extraTime' | 'penalties'>)
  | (Extract<KnockoutLegInput, { kind: 'forecast' }> &
      Pick<LegForecast, 'extraTime' | 'penalties'>);

export type ChampionsLeagueKnockoutForecasts = {
  readonly leg: (match: LeagueLegRateRequest) => LegForecast | null;
  readonly final: (fixture: ChampionsLeagueFinalFixture) => FinalForecast | null;
};

function hasCompleteObservedDecider(
  tiedAfterRegulation: boolean,
  { extraTime, penalties }: Pick<ObservedScore, 'extraTime' | 'penalties'>,
) {
  if (!tiedAfterRegulation) return extraTime === null && penalties === null;
  return (
    extraTime !== null &&
    (extraTime.homeGoals30 === extraTime.awayGoals30) === (penalties !== null)
  );
}

/**
 * Supply knockout inputs from one cutoff snapshot and explicit forecast rates.
 * Observations are used on confirmed paths. Future official fixtures must be
 * identifiable in the observed calendar. Scenario draws use their own venues.
 */
export function createChampionsLeagueKnockoutMatchProviders({
  season,
  dataCutoffMs,
  observations,
  forecasts,
}: Readonly<{
  season: number;
  dataCutoffMs: number;
  observations: readonly Readonly<Observation>[];
  forecasts: ChampionsLeagueKnockoutForecasts;
}>): ChampionsLeagueMatchProviders {
  if (
    !Number.isFinite(new Date(dataCutoffMs).getTime()) ||
    observations.some((match) => !(match.observedAt.getTime() < dataCutoffMs))
  )
    throw new RangeError('knockout inputs require observations before the cutoff');

  const lookup = createChampionsLeagueKnockoutFixtureLookup(season, observations);
  const { leg: forecastLeg, final: forecastFinal } = forecasts;

  function isFuture(match: Observation) {
    return match.utcDate.getTime() > dataCutoffMs && isPrematchFixture(match);
  }

  function knownScore(match: Observation) {
    return match.status === 'FINISHED' && match.utcDate.getTime() < dataCutoffMs
      ? match.result
      : null;
  }

  function projectedLeg(request: LeagueLegRateRequest): PreparedLeg | null {
    const rates = forecastLeg(request);
    if (rates === null) return null;
    const { leg, homeTeamId, awayTeamId } = request;
    return { ...rates, kind: 'forecast', leg, homeTeamId, awayTeamId };
  }

  function recordedLeg(
    stage: TwoLegStage,
    pair: TeamPair,
    match: Observation,
    leg: 1 | 2,
  ): PreparedLeg | null {
    const result = knownScore(match);
    if (result !== null)
      return {
        ...result.regulation,
        leg,
        extraTime: result.extraTime,
        penalties: result.penalties,
      };

    const { homeTeamId, awayTeamId } = match;
    if (homeTeamId === null || awayTeamId === null || !isFuture(match)) return null;
    return projectedLeg({ ...pair, stage, leg, homeTeamId, awayTeamId });
  }

  function prepareTie(
    draw: Draw,
    stage: TwoLegStage,
    { firstTeamId, secondTeamId, firstLegHomeTeamId }: DrawnTie,
  ): ChampionsLeagueTwoLegMatchInputs | null {
    if (draw.season !== season) return null;
    const pair = { firstTeamId, secondTeamId };
    let first: PreparedLeg | null;
    let second: PreparedLeg | null;
    if (draw.source === 'official') {
      const matched = lookup.twoLeg({ ...draw, ...pair, stage, firstLegHomeTeamId });
      if (matched.status !== 'matched') return null;
      first = recordedLeg(stage, pair, matched.fixtures[0], 1);
      second = recordedLeg(stage, pair, matched.fixtures[1], 2);
    } else {
      if (firstLegHomeTeamId !== firstTeamId && firstLegHomeTeamId !== secondTeamId)
        return null;
      const secondHome =
        firstLegHomeTeamId === firstTeamId ? secondTeamId : firstTeamId;
      first = projectedLeg({
        ...pair,
        stage,
        leg: 1,
        homeTeamId: firstLegHomeTeamId,
        awayTeamId: secondHome,
      });
      second = projectedLeg({
        ...pair,
        stage,
        leg: 2,
        homeTeamId: secondHome,
        awayTeamId: firstLegHomeTeamId,
      });
    }

    if (first === null || second === null) return null;
    const {
      extraTime: firstExtraTime,
      penalties: firstPenalties,
      ...firstLeg
    } = first;
    if (
      firstLeg.kind === 'known-result' &&
      (firstExtraTime !== null || firstPenalties !== null)
    )
      return null;
    if (
      second.kind === 'known-result' &&
      (first.kind !== 'known-result' ||
        !hasCompleteObservedDecider(
          first.homeGoals90 + second.awayGoals90 ===
            first.awayGoals90 + second.homeGoals90,
          second,
        ))
    )
      return null;

    const { extraTime, penalties, ...secondLeg } = second;
    return { ...pair, legs: [firstLeg, secondLeg], extraTime, penalties };
  }

  function round<Tie extends Pick<DrawnTie, 'firstLegHomeTeamId'>>(
    draw: Draw & { readonly ties: readonly Tie[] },
    stage: TwoLegStage,
    orderedPair: (tie: Tie) => readonly [number, number],
  ) {
    return draw.ties.flatMap((tie) => {
      const [firstTeamId, secondTeamId] = orderedPair(tie);
      const { firstLegHomeTeamId } = tie;
      const input = prepareTie(draw, stage, {
        firstTeamId,
        secondTeamId,
        firstLegHomeTeamId,
      });
      return input === null ? [] : [input];
    });
  }

  return {
    playOff: (draw) =>
      round(draw, 'PLAYOFFS', ({ seeded, unseeded }) => [
        seeded.teamId,
        unseeded.teamId,
      ]).map(({ firstTeamId, secondTeamId, ...input }) => ({
        ...input,
        seededTeamId: firstTeamId,
        unseededTeamId: secondTeamId,
      })),
    roundOf16: (draw) =>
      round(draw, 'LAST_16', ({ seeded, playOffWinner }) => [
        seeded.teamId,
        playOffWinner.club.teamId,
      ]),
    quarterFinals: (draw) =>
      round(draw, 'QUARTER_FINALS', ({ first, second }) => [
        first.club.teamId,
        second.club.teamId,
      ]),
    semiFinals: (draw) =>
      round(draw, 'SEMI_FINALS', ({ first, second }) => [
        first.club.teamId,
        second.club.teamId,
      ]),
    final(fixture) {
      if (fixture.season !== season) return null;
      const silverTeamId = fixture.silver.club.teamId;
      const blueTeamId = fixture.blue.club.teamId;
      if (fixture.source === 'official') {
        const matched = lookup.final(fixture);
        if (matched.status !== 'matched') return null;
        const [match] = matched.fixtures;
        const result = knownScore(match);
        if (result !== null) {
          const { regulation, extraTime, penalties } = result;
          if (
            !hasCompleteObservedDecider(
              regulation.homeGoals90 === regulation.awayGoals90,
              result,
            )
          )
            return null;
          const silverAtHome = regulation.homeTeamId === silverTeamId;
          return {
            silverTeamId,
            blueTeamId,
            regulation: {
              kind: 'known-result',
              silverGoals90: silverAtHome
                ? regulation.homeGoals90
                : regulation.awayGoals90,
              blueGoals90: silverAtHome
                ? regulation.awayGoals90
                : regulation.homeGoals90,
            },
            extraTime:
              extraTime === null
                ? null
                : {
                    kind: 'known-result',
                    silverGoals30: silverAtHome
                      ? extraTime.homeGoals30
                      : extraTime.awayGoals30,
                    blueGoals30: silverAtHome
                      ? extraTime.awayGoals30
                      : extraTime.homeGoals30,
                  },
            penalties,
          };
        }
        if (!isFuture(match)) return null;
      }
      const rates = forecastFinal(fixture);
      return rates === null ? null : { silverTeamId, blueTeamId, ...rates };
    },
  };
}
