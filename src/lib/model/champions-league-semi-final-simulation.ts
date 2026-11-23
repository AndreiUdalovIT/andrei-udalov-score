import { CHAMPIONS_LEAGUE_QUARTER_FINAL_BANDS } from './champions-league-quarter-final-draw';
import {
  copyChampionsLeagueQuarterFinalDrawMetadata,
  isChampionsLeagueRoundOf16WinnerPosition,
} from './champions-league-quarter-final-simulation';
import {
  CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
  type ChampionsLeagueSemiFinalTie,
  type RecordedChampionsLeagueSemiFinalDraw,
  type SimulatedChampionsLeagueSemiFinalDraw,
} from './champions-league-semi-final-draw';
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

export const CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM =
  'ucl-side-ordered-two-leg-semi-finals-v1';

type Draw =
  RecordedChampionsLeagueSemiFinalDraw | SimulatedChampionsLeagueSemiFinalDraw;
type DrawMetadata =
  | Omit<RecordedChampionsLeagueSemiFinalDraw, 'ties'>
  | Omit<SimulatedChampionsLeagueSemiFinalDraw, 'ties'>;
type SemiFinalSlot = Pick<ChampionsLeagueSemiFinalTie, 'side'>;

/** firstTeamId and secondTeamId follow the 1/2 and 3/4 feeder paths. */
export type ChampionsLeagueSemiFinalMatchInputs = ChampionsLeagueTwoLegMatchInputs;

export type ChampionsLeagueSemiFinalSample = {
  algorithm: typeof CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM;
  knockoutAlgorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  draw: DrawMetadata;
  /** Each winner keeps its side for the final. */
  ties: { tie: ChampionsLeagueSemiFinalTie; result: SampledKnockout }[];
};

export type ChampionsLeagueSemiFinalPreparation = ChampionsLeagueTwoLegPreparation<
  SemiFinalSlot,
  ChampionsLeagueSemiFinalSample
>;

function copyDrawMetadata(draw: Draw): DrawMetadata {
  if (
    draw.algorithm !== CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM ||
    draw.quarterFinalDraw?.season !== draw.season
  )
    throw new RangeError(
      'semi-finals require a compatible draw and quarter-final season',
    );

  const quarterFinalDraw = copyChampionsLeagueQuarterFinalDrawMetadata(
    draw.quarterFinalDraw,
  );
  const common = {
    season: draw.season,
    algorithm: draw.algorithm,
    quarterFinalDraw,
  };
  const homeOrder = draw.homeOrder;
  if (
    homeOrder?.source === 'official' &&
    quarterFinalDraw.roundOf16Draw.source === 'official' &&
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
      homeOrder.randomDraws === 2) ||
      (draw.season !== 2024 && homeOrder?.source === 'inherited-seeding'))
  )
    return { ...common, source: 'simulated', homeOrder: { ...homeOrder } };

  throw new RangeError(
    'semi-final draw requires a home order consistent with its source and season',
  );
}

function copyTies(draw: Draw): ChampionsLeagueSemiFinalTie[] {
  if (draw.ties.length !== 2)
    throw new RangeError('Champions League semi-finals require two ties');
  const sides = new Set<ChampionsLeagueSemiFinalTie['side']>();
  const positions = new Set<number>();
  const teams = new Set<number>();
  const ties = Array.from(draw.ties, (tie) => {
    if (
      tie == null ||
      (tie.side !== 'silver' && tie.side !== 'blue') ||
      sides.has(tie.side)
    )
      throw new RangeError('semi-finals require exactly one tie per side');
    sides.add(tie.side);

    for (const [winner, feeder] of [
      [tie.first, 1],
      [tie.second, 3],
    ] as const) {
      if (
        winner?.slot?.side !== tie.side ||
        winner.slot.seededPairStart !== feeder ||
        (winner.source !== 'observed' && winner.source !== 'simulated') ||
        (winner.source === 'observed' && draw.quarterFinalDraw.source !== 'official')
      )
        throw new RangeError(
          'semi-final entrants must retain their quarter-final feeder slots',
        );

      const band = CHAMPIONS_LEAGUE_QUARTER_FINAL_BANDS.find(
        ({ seededPairStart }) => seededPairStart === feeder,
      )!;
      const club = winner.club;
      if (
        club == null ||
        ![band.seededPairStart, band.opponentPairStart].some((path) =>
          isChampionsLeagueRoundOf16WinnerPosition(path, club.position),
        ) ||
        positions.has(club.position) ||
        !Number.isSafeInteger(club.teamId) ||
        club.teamId <= 0 ||
        teams.has(club.teamId)
      )
        throw new RangeError(
          'semi-final ties require unique clubs and permitted league positions',
        );
      positions.add(club.position);
      teams.add(club.teamId);
    }

    const home = tie.firstLegHomeTeamId;
    if (
      (draw.homeOrder.source === 'inherited-seeding' &&
        home !== tie.second.club.teamId) ||
      (home === null
        ? draw.homeOrder.source !== 'official'
        : home !== tie.first.club.teamId && home !== tie.second.club.teamId)
    )
      throw new RangeError('invalid first leg host for the semi-final');
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
      'an official semi-final draw requires all quarter-final winners to be observed',
    );

  return ties.sort(
    (left, right) => Number(left.side === 'blue') - Number(right.side === 'blue'),
  );
}

/** Validate and snapshot an existing semi-final draw in bracket order. */
export function copyChampionsLeagueSemiFinalDraw(draw: Draw): Draw {
  return { ...copyDrawMetadata(draw), ties: copyTies(draw) };
}

/**
 * Resolve both semi-finals with the standard two-leg knockout rules.
 * Match inputs supply played scores or explicit forecasts for the drawn pairs.
 * A published home order must agree with the leg inputs when available.
 * Missing inputs withhold the round and identify the affected sides.
 * Sample silver first, then blue, retaining each winner's path to the final.
 */
export function createChampionsLeagueSemiFinalSimulation(
  draw: Draw,
  matches: readonly ChampionsLeagueSemiFinalMatchInputs[],
  sampling: Readonly<PoissonDistributionOptions>,
): ChampionsLeagueSemiFinalPreparation {
  const { ties, ...drawMetadata } = copyChampionsLeagueSemiFinalDraw(draw);
  const prepared = prepareChampionsLeagueTwoLegRound(
    ties.map((tie) => ({
      tie,
      slot: { side: tie.side },
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
        algorithm: CHAMPIONS_LEAGUE_SEMI_FINAL_SIMULATION_ALGORITHM,
        knockoutAlgorithm: KNOCKOUT_SAMPLING_ALGORITHM,
        draw: structuredClone(drawMetadata),
        ties: prepared.sample(random),
      };
    },
  };
}
