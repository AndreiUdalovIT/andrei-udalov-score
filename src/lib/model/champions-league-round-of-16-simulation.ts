import { CHAMPIONS_LEAGUE_PLAY_OFF_BANDS } from './champions-league-play-off-draw';
import { copyChampionsLeaguePlayOffDrawMetadata } from './champions-league-play-off-simulation';
import {
  CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS,
  CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
  type ChampionsLeagueRoundOf16Tie,
  type RecordedChampionsLeagueRoundOf16Draw,
  type SimulatedChampionsLeagueRoundOf16Draw,
} from './champions-league-round-of-16-draw';
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

export const CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM =
  'ucl-slot-ordered-two-leg-round-of-16-v1';

type Draw =
  RecordedChampionsLeagueRoundOf16Draw | SimulatedChampionsLeagueRoundOf16Draw;
type DrawMetadata =
  | Omit<RecordedChampionsLeagueRoundOf16Draw, 'ties'>
  | Omit<SimulatedChampionsLeagueRoundOf16Draw, 'ties'>;
type RoundOf16Slot = Pick<ChampionsLeagueRoundOf16Tie, 'seededPairStart' | 'side'>;

/** firstTeamId is the top-eight club and secondTeamId is the play-off winner. */
export type ChampionsLeagueRoundOf16MatchInputs = ChampionsLeagueTwoLegMatchInputs;

export type ChampionsLeagueRoundOf16Sample = {
  algorithm: typeof CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM;
  knockoutAlgorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  draw: DrawMetadata;
  /** Each winner advances from the round-of-16 slot on this side of the bracket. */
  ties: { tie: ChampionsLeagueRoundOf16Tie; result: SampledKnockout }[];
};

export type ChampionsLeagueRoundOf16Preparation = ChampionsLeagueTwoLegPreparation<
  RoundOf16Slot,
  ChampionsLeagueRoundOf16Sample
>;

function copyDrawMetadata(draw: Draw): DrawMetadata {
  if (
    draw.algorithm !== CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM ||
    draw.playOffDraw?.season !== draw.season
  )
    throw new RangeError(
      'round of 16 requires a compatible draw and play-off season',
    );

  const playOffDraw = copyChampionsLeaguePlayOffDrawMetadata(draw.playOffDraw);
  const common = { season: draw.season, algorithm: draw.algorithm, playOffDraw };
  if (
    draw.source === 'official' &&
    typeof draw.sourceReference === 'string' &&
    draw.sourceReference.trim() !== '' &&
    playOffDraw.source === 'official'
  )
    return { ...common, source: 'official', sourceReference: draw.sourceReference };
  if (
    draw.source === 'simulated' &&
    draw.lotSamplingAlgorithm === SEASON_LOTS_SAMPLING_ALGORITHM &&
    draw.randomDraws === 4
  )
    return {
      ...common,
      source: 'simulated',
      lotSamplingAlgorithm: draw.lotSamplingAlgorithm,
      randomDraws: draw.randomDraws,
    };
  throw new RangeError('round-of-16 draw requires valid provenance');
}

function copyTies(draw: Draw): ChampionsLeagueRoundOf16Tie[] {
  if (draw.ties.length !== 8)
    throw new RangeError('Champions League round of 16 requires eight ties');

  const slots = new Set<string>();
  const positions = new Set<number>();
  const clubs = new Set<number>();
  const ties = Array.from(draw.ties, (tie) => {
    if (tie == null || (tie.side !== 'silver' && tie.side !== 'blue'))
      throw new RangeError('each round-of-16 tie requires a valid bracket slot');
    const band = CHAMPIONS_LEAGUE_ROUND_OF_16_BANDS.find(
      ({ seededPairStart }) => seededPairStart === tie.seededPairStart,
    );
    const slot = tie.seededPairStart + ':' + tie.side;
    if (band === undefined || slots.has(slot))
      throw new RangeError('each round-of-16 band requires one tie per side');
    slots.add(slot);

    const winner = tie.playOffWinner;
    if (
      winner?.slot?.seededPairStart !== band.playOffSeededPairStart ||
      winner.slot.side !== tie.side ||
      (winner.source !== 'observed' && winner.source !== 'simulated') ||
      (winner.source === 'observed' && draw.playOffDraw.source !== 'official') ||
      (draw.source === 'official' && winner.source !== 'observed')
    )
      throw new RangeError(
        'round-of-16 ties must retain their play-off winner slots',
      );

    const playOffBand = CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.find(
      ({ seededPairStart }) => seededPairStart === band.playOffSeededPairStart,
    )!;
    for (const [club, starts] of [
      [tie.seeded, [band.seededPairStart]],
      [winner.club, [playOffBand.seededPairStart, playOffBand.unseededPairStart]],
    ] as const) {
      if (
        club == null ||
        !starts.some(
          (start) => club.position === start || club.position === start + 1,
        ) ||
        positions.has(club.position) ||
        !Number.isSafeInteger(club.teamId) ||
        club.teamId <= 0 ||
        clubs.has(club.teamId)
      )
        throw new RangeError(
          'round-of-16 ties require unique clubs and permitted league positions',
        );
      positions.add(club.position);
      clubs.add(club.teamId);
    }

    const firstHome = tie.firstLegHomeTeamId;
    if (
      (draw.source === 'simulated' && firstHome !== winner.club.teamId) ||
      (firstHome !== null &&
        firstHome !== tie.seeded.teamId &&
        firstHome !== winner.club.teamId)
    )
      throw new RangeError('invalid first leg host for the round-of-16 pair');

    return structuredClone(tie);
  });
  return ties.sort(
    (left, right) =>
      left.seededPairStart - right.seededPairStart ||
      Number(left.side === 'blue') - Number(right.side === 'blue'),
  );
}

/**
 * Prepare a complete round of 16 under Articles 20–21 for an existing draw.
 * Matches supply explicit venues, regulation scores or rates, and any required
 * extra time and penalties. The caller authenticates official data and cutoff.
 * A missing prerequisite withholds the round and identifies the affected slots.
 * Sampling follows seeded bands 1/3/5/7, silver then blue, and preserves the
 * draw's provenance and the slot through which each winner advances.
 */
export function createChampionsLeagueRoundOf16Simulation(
  draw: Draw,
  matches: readonly ChampionsLeagueRoundOf16MatchInputs[],
  sampling: Readonly<PoissonDistributionOptions>,
): ChampionsLeagueRoundOf16Preparation {
  const drawMetadata = copyDrawMetadata(draw);
  const ties = copyTies(draw);
  const prepared = prepareChampionsLeagueTwoLegRound(
    ties.map((tie) => ({
      tie,
      slot: { seededPairStart: tie.seededPairStart, side: tie.side },
      firstTeamId: tie.seeded.teamId,
      secondTeamId: tie.playOffWinner.club.teamId,
      firstLegHomeTeamId: tie.firstLegHomeTeamId,
    })),
    matches,
    draw.source,
    sampling,
  );
  if (prepared.status === 'unavailable') return prepared;
  return {
    status: 'ready',
    tailUpperBound: prepared.tailUpperBound,
    sample(random) {
      return {
        algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM,
        knockoutAlgorithm: KNOCKOUT_SAMPLING_ALGORITHM,
        draw: structuredClone(drawMetadata),
        ties: prepared.sample(random),
      };
    },
  };
}
