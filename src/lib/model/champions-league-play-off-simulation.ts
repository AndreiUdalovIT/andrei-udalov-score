import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  CHAMPIONS_LEAGUE_PLAY_OFF_BANDS,
  CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
  type ChampionsLeaguePlayOffTie,
  type RecordedChampionsLeaguePlayOffDraw,
  type SimulatedChampionsLeaguePlayOffDraw,
} from './champions-league-play-off-draw';
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

export const CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM =
  'ucl-slot-ordered-two-leg-play-offs-v1';

type Draw = RecordedChampionsLeaguePlayOffDraw | SimulatedChampionsLeaguePlayOffDraw;
type DrawMetadata =
  | Omit<RecordedChampionsLeaguePlayOffDraw, 'ties'>
  | Omit<SimulatedChampionsLeaguePlayOffDraw, 'ties'>;

type PlayOffSlot = Pick<ChampionsLeaguePlayOffTie, 'seededPairStart' | 'side'>;

export type ChampionsLeaguePlayOffMatchInputs = Omit<
  ChampionsLeagueTwoLegMatchInputs,
  'firstTeamId' | 'secondTeamId'
> & {
  readonly seededTeamId: number;
  readonly unseededTeamId: number;
};

export type ChampionsLeaguePlayOffSample = {
  algorithm: typeof CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM;
  knockoutAlgorithm: typeof KNOCKOUT_SAMPLING_ALGORITHM;
  draw: DrawMetadata;
  /** Each winner takes this tie's slot, regardless of which club was seeded. */
  ties: { tie: ChampionsLeaguePlayOffTie; result: SampledKnockout }[];
};

export type ChampionsLeaguePlayOffPreparation = ChampionsLeagueTwoLegPreparation<
  PlayOffSlot,
  ChampionsLeaguePlayOffSample
>;

export function copyChampionsLeaguePlayOffDrawMetadata(
  draw: DrawMetadata,
): DrawMetadata {
  const format = getCompetitionSeasonConfig('CL', draw.season);
  if (
    draw.algorithm !== CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM ||
    format?.format !== 'league-phase' ||
    format.teamCount !== 36
  )
    throw new RangeError('draw must use the standard Champions League league phase');

  const common = { season: draw.season, algorithm: draw.algorithm };
  if (
    draw.source === 'official' &&
    typeof draw.sourceReference === 'string' &&
    draw.sourceReference.trim() !== ''
  )
    return { ...common, source: 'official', sourceReference: draw.sourceReference };
  if (
    draw.source === 'simulated' &&
    draw.lotSamplingAlgorithm === SEASON_LOTS_SAMPLING_ALGORITHM &&
    draw.randomDraws === 8
  )
    return {
      ...common,
      source: 'simulated',
      lotSamplingAlgorithm: draw.lotSamplingAlgorithm,
      randomDraws: draw.randomDraws,
    };
  throw new RangeError(
    'draw must retain its source reference or simulation metadata',
  );
}

function copyTies(draw: Draw): ChampionsLeaguePlayOffTie[] {
  if (draw.ties.length !== 8)
    throw new RangeError('Champions League play-offs require eight ties');
  const slots = new Set<string>();
  const positions = new Set<number>();
  const ids = new Set<number>();
  const ties = Array.from(draw.ties, (tie) => {
    if (tie == null || (tie.side !== 'silver' && tie.side !== 'blue'))
      throw new RangeError('each tie requires a valid bracket slot');
    const band = CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.find(
      ({ seededPairStart }) => seededPairStart === tie.seededPairStart,
    );
    const slot = tie.seededPairStart + ':' + tie.side;
    if (band === undefined || slots.has(slot))
      throw new RangeError('each draw band requires one tie per side');
    slots.add(slot);

    for (const [club, start] of [
      [tie.seeded, band.seededPairStart],
      [tie.unseeded, band.unseededPairStart],
    ] as const) {
      if (
        club == null ||
        (club.position !== start && club.position !== start + 1) ||
        positions.has(club.position) ||
        !Number.isSafeInteger(club.teamId) ||
        club.teamId <= 0 ||
        ids.has(club.teamId)
      )
        throw new RangeError(
          'ties require unique clubs and permitted league positions',
        );
      positions.add(club.position);
      ids.add(club.teamId);
    }

    const firstHome = tie.firstLegHomeTeamId;
    if (
      (draw.source === 'simulated' && firstHome !== tie.unseeded.teamId) ||
      (firstHome !== null &&
        firstHome !== tie.seeded.teamId &&
        firstHome !== tie.unseeded.teamId)
    )
      throw new RangeError('invalid first leg host for the drawn pair');

    return {
      seededPairStart: tie.seededPairStart,
      side: tie.side,
      seeded: { teamId: tie.seeded.teamId, position: tie.seeded.position },
      unseeded: { teamId: tie.unseeded.teamId, position: tie.unseeded.position },
      firstLegHomeTeamId: firstHome,
    };
  });
  return ties.sort(
    (left, right) =>
      left.seededPairStart - right.seededPairStart ||
      Number(left.side === 'blue') - Number(right.side === 'blue'),
  );
}

/**
 * Prepare the eight two-leg UCL play-offs under Articles 20–21. Supply a
 * standard, already resolved draw and match inputs for its exact ordered pairs.
 * Use the first leg host from the draw when known. Otherwise the two legs must
 * supply their home order explicitly. Exceptional formats are out of scope.
 *
 * Keep observed scores only with an official draw and require observed first
 * legs before observed return legs. Callers establish authenticity and cutoff.
 * Future scores and any extra time/shootout are handled by the knockout sampler
 * with explicitly supplied rates/probabilities. If extra time could be reached
 * and has no input, withhold the round. Never resolve an aggregate tie directly
 * with penalties. No partial results are exposed for an unavailable round.
 *
 * Throw RangeError for contradictory draw or match inputs. Report missing
 * inputs or unavailable samplers by slot. A successful sample consumes the
 * supplied RNG in seeded pair order 9/11/13/15, silver then blue for each pair.
 */
export function createChampionsLeaguePlayOffSimulation(
  draw: Draw,
  matches: readonly ChampionsLeaguePlayOffMatchInputs[],
  sampling: Readonly<PoissonDistributionOptions>,
): ChampionsLeaguePlayOffPreparation {
  const drawMetadata = copyChampionsLeaguePlayOffDrawMetadata(draw);
  const ties = copyTies(draw);
  const prepared = prepareChampionsLeagueTwoLegRound(
    ties.map((tie) => ({
      tie,
      slot: { seededPairStart: tie.seededPairStart, side: tie.side },
      firstTeamId: tie.seeded.teamId,
      secondTeamId: tie.unseeded.teamId,
      firstLegHomeTeamId: tie.firstLegHomeTeamId,
    })),
    Array.from(matches, (match) => {
      if (match == null)
        throw new RangeError('play-off inputs cannot contain missing entries');
      const { seededTeamId, unseededTeamId, ...inputs } = match;
      return { ...inputs, firstTeamId: seededTeamId, secondTeamId: unseededTeamId };
    }),
    draw.source,
    sampling,
  );
  if (prepared.status === 'unavailable') return prepared;
  return {
    status: 'ready',
    tailUpperBound: prepared.tailUpperBound,
    sample(random) {
      return {
        algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM,
        knockoutAlgorithm: KNOCKOUT_SAMPLING_ALGORITHM,
        draw: { ...drawMetadata },
        ties: prepared.sample(random),
      };
    },
  };
}
