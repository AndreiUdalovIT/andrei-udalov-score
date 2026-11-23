import { CHAMPIONS_LEAGUE_PLAY_OFF_BANDS } from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_BANDS,
  CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
  type ChampionsLeagueQuarterFinalTie,
  type RecordedChampionsLeagueQuarterFinalDraw,
  type SimulatedChampionsLeagueQuarterFinalDraw,
} from './champions-league-quarter-final-draw';
import { CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS } from './champions-league-round-of-16-draw';
import { copyChampionsLeagueRoundOf16DrawMetadata } from './champions-league-round-of-16-simulation';
import {
  prepareChampionsLeagueTwoLegRound,
  type ChampionsLeagueTwoLegMatchInputs,
  type ChampionsLeagueTwoLegPreparation,
} from './champions-league-two-leg-round';
import {
  KNOCKOUT_SAMPLING_ALGORITHM,
  type SampledKnockout,
} from './knockout-sampler';
import type { PoissonDistributionOptions } from './poisson-distribution';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';

export const CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM =
  'ucl-slot-ordered-two-leg-quarter-finals-v1';

type Draw =
  RecordedChampionsLeagueQuarterFinalDraw | SimulatedChampionsLeagueQuarterFinalDraw;
type DrawMetadata =
  | Omit<RecordedChampionsLeagueQuarterFinalDraw, 'ties'>
  | Omit<SimulatedChampionsLeagueQuarterFinalDraw, 'ties'>;
type QuarterFinalSlot = Pick<
  ChampionsLeagueQuarterFinalTie,
  'seededPairStart' | 'side'
>;

/** firstTeamId and secondTeamId follow the quarter-final feeder order. */
export type ChampionsLeagueQuarterFinalMatchInputs =
  ChampionsLeagueTwoLegMatchInputs;

export type ChampionsLeagueQuarterFinalSample = {
  algorithm: typeof CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM;
  knockoutAlgorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  draw: DrawMetadata;
  /** The winner takes the tie's whole path, including inherited seeding. */
  ties: { tie: ChampionsLeagueQuarterFinalTie; result: SampledKnockout }[];
};

export type ChampionsLeagueQuarterFinalPreparation =
  ChampionsLeagueTwoLegPreparation<
    QuarterFinalSlot,
    ChampionsLeagueQuarterFinalSample
  >;

function copyDrawMetadata(draw: Draw): DrawMetadata {
  if (
    draw.algorithm !== CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM ||
    ![2024, 2025, 2026].includes(draw.season) ||
    draw.roundOf16Draw?.season !== draw.season
  )
    throw new RangeError(
      'quarter-finals require a compatible draw and round-of-16 season',
    );

  const roundOf16Draw = copyChampionsLeagueRoundOf16DrawMetadata(draw.roundOf16Draw);
  const common = { season: draw.season, algorithm: draw.algorithm, roundOf16Draw };
  const homeOrder = draw.homeOrder;
  if (
    homeOrder?.source === 'official' &&
    roundOf16Draw.source === 'official' &&
    (draw.source === 'official' || draw.source === 'simulated') &&
    typeof homeOrder.sourceReference === 'string' &&
    homeOrder.sourceReference.trim() !== ''
  )
    return { ...common, source: draw.source, homeOrder: { ...homeOrder } };

  if (
    draw.source === 'simulated' &&
    ((draw.season === 2024 &&
      homeOrder?.source === 'simulated-lots' &&
      homeOrder.lotSamplingAlgorithm === SEASON_LOTS_SAMPLING_ALGORITHM &&
      homeOrder.randomDraws === 4) ||
      (draw.season !== 2024 && homeOrder?.source === 'inherited-seeding'))
  )
    return { ...common, source: 'simulated', homeOrder: { ...homeOrder } };

  throw new RangeError(
    'quarter-final draw requires a home order consistent with its source and season',
  );
}

function copyTies(draw: Draw): ChampionsLeagueQuarterFinalTie[] {
  if (draw.ties.length !== 4)
    throw new RangeError('Champions League quarter-finals require four ties');

  const slots = new Set<string>();
  const positions = new Set<number>();
  const teams = new Set<number>();
  const ties = Array.from(draw.ties, (tie) => {
    if (tie == null || (tie.side !== 'silver' && tie.side !== 'blue'))
      throw new RangeError('each quarter-final needs a valid bracket slot');
    const band = CHAMPIONS_LEAGUE_QUARTER_FINAL_BANDS.find(
      ({ seededPairStart }) => seededPairStart === tie.seededPairStart,
    );
    const slot = tie.seededPairStart + ':' + tie.side;
    if (band === undefined || slots.has(slot))
      throw new RangeError('each quarter-final band requires one tie per side');
    slots.add(slot);

    for (const [winner, feeder] of [
      [tie.first, band.seededPairStart],
      [tie.second, band.opponentPairStart],
    ] as const) {
      if (
        winner?.slot?.seededPairStart !== feeder ||
        winner.slot.side !== tie.side ||
        (winner.source !== 'observed' && winner.source !== 'simulated') ||
        (winner.source === 'observed' && draw.roundOf16Draw.source !== 'official')
      )
        throw new RangeError(
          'quarter-final entrants must retain their round-of-16 feeder slots',
        );

      const roundOf16Band = CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS.find(
        ({ seededPairStart }) => seededPairStart === feeder,
      )!;
      const playOffBand = CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.find(
        ({ seededPairStart }) =>
          seededPairStart === roundOf16Band.playOffSeededPairStart,
      )!;
      const starts = [
        feeder,
        playOffBand.seededPairStart,
        playOffBand.unseededPairStart,
      ];
      const club = winner.club;
      if (
        club == null ||
        !starts.some(
          (start) => club.position === start || club.position === start + 1,
        ) ||
        positions.has(club.position) ||
        !Number.isSafeInteger(club.teamId) ||
        club.teamId <= 0 ||
        teams.has(club.teamId)
      )
        throw new RangeError(
          'quarter-final ties require unique clubs and permitted league positions',
        );
      positions.add(club.position);
      teams.add(club.teamId);
    }

    const firstHome = tie.firstLegHomeTeamId;
    if (
      (draw.homeOrder.source === 'inherited-seeding' &&
        firstHome !== tie.second.club.teamId) ||
      (firstHome === null
        ? draw.homeOrder.source !== 'official'
        : firstHome !== tie.first.club.teamId &&
          firstHome !== tie.second.club.teamId)
    )
      throw new RangeError('invalid first leg host for the quarter-final');

    return structuredClone(tie);
  });
  const allObserved = ties.every(
    ({ first, second }) =>
      first.source === 'observed' && second.source === 'observed',
  );
  if (
    draw.homeOrder.source === 'official' &&
    (draw.source === 'official') !== allObserved
  )
    throw new RangeError(
      'an official quarter-final draw requires all round-of-16 winners to be observed',
    );

  return ties.sort(
    (left, right) =>
      Number(left.side === 'blue') - Number(right.side === 'blue') ||
      left.seededPairStart - right.seededPairStart,
  );
}

/** Validate and snapshot an existing quarter-final draw in bracket order. */
export function copyChampionsLeagueQuarterFinalDraw(draw: Draw): Draw {
  return { ...copyDrawMetadata(draw), ties: copyTies(draw) };
}

/**
 * Resolve all four quarter-finals with the standard two-leg knockout rules.
 * The caller supplies cutoff-safe observations or explicit forecasts for each
 * drawn pair. Use the recorded first host when present and the supplied leg
 * order otherwise. Missing inputs identify blocked slots and withhold the round.
 * Sample in silver then blue order, with the 1/2 branch before 3/4 on each side.
 */
export function createChampionsLeagueQuarterFinalSimulation(
  draw: Draw,
  matches: readonly ChampionsLeagueQuarterFinalMatchInputs[],
  sampling: Readonly<PoissonDistributionOptions>,
): ChampionsLeagueQuarterFinalPreparation {
  const { ties, ...drawMetadata } = copyChampionsLeagueQuarterFinalDraw(draw);
  const prepared = prepareChampionsLeagueTwoLegRound(
    ties.map((tie) => ({
      tie,
      slot: { seededPairStart: tie.seededPairStart, side: tie.side },
      firstTeamId: tie.first.club.teamId,
      secondTeamId: tie.second.club.teamId,
      firstLegHomeTeamId: tie.firstLegHomeTeamId,
    })),
    matches,
    drawMetadata.source,
    sampling,
  );
  if (prepared.status === 'unavailable') return prepared;
  return {
    status: 'ready',
    tailUpperBound: prepared.tailUpperBound,
    sample(random) {
      return {
        algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM,
        knockoutAlgorithm: KNOCKOUT_SAMPLING_ALGORITHM,
        draw: structuredClone(drawMetadata),
        ties: prepared.sample(random),
      };
    },
  };
}
