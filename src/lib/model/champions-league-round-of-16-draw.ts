import {
  CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
  createChampionsLeaguePlayOffDraw,
  type ChampionsLeaguePlayOffTie,
} from './champions-league-play-off-draw';
import {
  CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM,
  type ChampionsLeaguePlayOffSample,
} from './champions-league-play-off-simulation';
import { KNOCKOUT_SAMPLING_ALGORITHM } from './knockout-sampler';
import {
  createSeasonLotsSampler,
  type SEASON_LOTS_SAMPLING_ALGORITHM,
} from './season-lots-sampler';

export const CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM =
  'ucl-round-of-16-ranked-bowls-v1';

const bands = [
  { seededPairStart: 1, playOffSeededPairStart: 15 },
  { seededPairStart: 3, playOffSeededPairStart: 13 },
  { seededPairStart: 5, playOffSeededPairStart: 11 },
  { seededPairStart: 7, playOffSeededPairStart: 9 },
] as const;
const bowlOrder = [...bands].reverse();
const sides = ['silver', 'blue'] as const;

type SeededPairStart = (typeof bands)[number]['seededPairStart'];
type PlayOffSlot = Pick<ChampionsLeaguePlayOffTie, 'seededPairStart' | 'side'>;
type BracketSide = ChampionsLeaguePlayOffTie['side'];
type Club = ChampionsLeaguePlayOffTie['seeded'];
type RankingGroups = Parameters<typeof createChampionsLeaguePlayOffDraw>[1];
type PlayOffWinner = {
  club: Club;
  slot: PlayOffSlot;
  source: 'observed' | 'simulated';
};

export type ChampionsLeagueRoundOf16Tie = {
  /** Use seededPairStart and side together; these are not UEFA match numbers. */
  seededPairStart: SeededPairStart;
  side: BracketSide;
  seeded: Club;
  playOffWinner: PlayOffWinner;
  firstLegHomeTeamId: number | null;
};

export type OfficialChampionsLeagueRoundOf16Draw = {
  readonly sourceReference: string;
  readonly ties: readonly {
    readonly side: BracketSide;
    readonly seededTeamId: number;
    readonly winnerTeamId: number;
    readonly firstLegHomeTeamId?: number | null;
  }[];
};

type RoundOf16Draw = {
  algorithm: typeof CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM;
  season: number;
  playOffDraw: ChampionsLeaguePlayOffSample['draw'];
  /** Canonical order, seeded pair starts 1/3/5/7, silver then blue. */
  ties: ChampionsLeagueRoundOf16Tie[];
};

export type SimulatedChampionsLeagueRoundOf16Draw = RoundOf16Draw & {
  source: 'simulated';
  lotSamplingAlgorithm: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
  randomDraws: number;
};

export type RecordedChampionsLeagueRoundOf16Draw = RoundOf16Draw & {
  source: 'official';
  sourceReference: string;
};

function slotKey(seededPairStart: number, side: BracketSide) {
  return seededPairStart + ':' + side;
}

function collectPlayOffWinners(
  playOff: ChampionsLeaguePlayOffSample,
  pools: NonNullable<
    ReturnType<typeof createChampionsLeaguePlayOffDraw>
  >['candidateBands'],
) {
  if (
    playOff.algorithm !== CHAMPIONS_LEAGUE_PLAY_OFF_SIMULATION_ALGORITHM ||
    playOff.knockoutAlgorithm !== KNOCKOUT_SAMPLING_ALGORITHM ||
    playOff.draw.algorithm !== CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM ||
    playOff.ties.length !== 8
  )
    throw new RangeError('round of 16 requires a complete supported play-off round');

  const winners = new Map<string, PlayOffWinner>();
  const usedClubs = new Set<number>();
  for (const { tie, result } of playOff.ties) {
    if (!sides.includes(tie.side))
      throw new RangeError('each play-off winner must retain their bracket side');
    const pool = pools.find(
      ({ seededPairStart }) => seededPairStart === tie.seededPairStart,
    );
    const slot = slotKey(tie.seededPairStart, tie.side);
    if (
      winners.has(slot) ||
      pool === undefined ||
      !pool.seeded.some(
        (club) =>
          club.teamId === tie.seeded.teamId && club.position === tie.seeded.position,
      ) ||
      !pool.unseeded.some(
        (club) =>
          club.teamId === tie.unseeded.teamId &&
          club.position === tie.unseeded.position,
      ) ||
      usedClubs.has(tie.seeded.teamId) ||
      usedClubs.has(tie.unseeded.teamId)
    )
      throw new RangeError(
        'play-off participants must match the final table and slots',
      );
    const winner = [tie.seeded, tie.unseeded].find(
      ({ teamId }) => teamId === result.winnerTeamId,
    );
    if (winner === undefined)
      throw new RangeError('each play-off winner must belong to the tie');
    usedClubs.add(tie.seeded.teamId);
    usedClubs.add(tie.unseeded.teamId);

    // Scores and the winner have already been resolved by the play-off simulator.
    const observed =
      playOff.draw.source === 'official' &&
      result.legs.length === 2 &&
      result.legs.every((leg) => leg.source === 'known-result') &&
      (result.extraTime === null || result.extraTime.source === 'known-result') &&
      (result.shootout === null || result.shootout.source === 'known-result');
    winners.set(slot, {
      club: { ...winner },
      slot: { seededPairStart: tie.seededPairStart, side: tie.side },
      source: observed ? 'observed' : 'simulated',
    });
  }
  return winners;
}

/**
 * Prepare the standard round-of-16 draw under UEFA article 19.03 and Annex B.
 * Use the final league phase groups and one resolved play-off round from the
 * same table. Ranks 1–8 and 9–24 must be individually resolved. Neither a
 * league-phase tie outside those ranks nor the order of input arrays affects
 * the draw. A missing individual rank returns null; invalid inputs throw.
 *
 * Draw the 7/8, 5/6, 3/4 and 1/2 bowls in that order. Each bowl's first
 * team goes to silver and the remaining team to blue. A play-off winner
 * stays in its original side and slot, even when it upset the seeded club.
 * Simulated ties put the seeded club at home in the return leg.
 *
 * An official draw requires observed winners from an official play-off draw.
 * Check every supplied pairing against its retained slot, and keep the source
 * reference and any supplied first-leg host. The caller authenticates official
 * data and the cutoff. Exceptional rule or bracket changes are out of scope.
 */
export function createChampionsLeagueRoundOf16Draw(
  groups: RankingGroups,
  playOff: ChampionsLeaguePlayOffSample,
) {
  const season = playOff.draw.season;
  const phase = createChampionsLeaguePlayOffDraw(season, groups);
  if (phase === null) return null;
  const directClubs = new Map(
    groups
      .filter((group) => group.to === group.from && group.from <= 8)
      .map((group): [number, Club] => [
        group.from,
        { teamId: group.teamIds[0]!, position: group.from },
      ]),
  );
  if (directClubs.size !== 8) return null;
  const winners = collectPlayOffWinners(playOff, phase.candidateBands);
  const playOffDraw = structuredClone(playOff.draw);
  const byTeam = new Map(
    [...directClubs.values()].map((club) => [club.teamId, club]),
  );
  const sampler = createSeasonLotsSampler(
    bowlOrder.map(({ seededPairStart }, index) => ({
      from: 2 * index + 1,
      to: 2 * index + 2,
      teamIds: [
        directClubs.get(seededPairStart)!.teamId,
        directClubs.get(seededPairStart + 1)!.teamId,
      ],
    })),
  );

  function makeTie(
    band: (typeof bands)[number],
    side: BracketSide,
    seeded: Club,
    host: number | null,
  ): ChampionsLeagueRoundOf16Tie {
    return {
      seededPairStart: band.seededPairStart,
      side,
      seeded: { ...seeded },
      playOffWinner: structuredClone(
        winners.get(slotKey(band.playOffSeededPairStart, side))!,
      ),
      firstLegHomeTeamId: host,
    };
  }

  function drawResult(ties: ChampionsLeagueRoundOf16Tie[]): RoundOf16Draw {
    return {
      algorithm: CHAMPIONS_LEAGUE_ROUND_OF_16_DRAW_ALGORITHM,
      season,
      playOffDraw: { ...playOffDraw },
      ties,
    };
  }

  return {
    sample(random: () => number): SimulatedChampionsLeagueRoundOf16Draw {
      const lots = sampler.sample(random);
      const orders = new Map(
        bowlOrder.map(({ seededPairStart }, index) => [
          seededPairStart,
          lots.orders[index]!.teamIds,
        ]),
      );
      const ties = bands.flatMap((band) =>
        sides.map((side, index) => {
          const seeded = byTeam.get(orders.get(band.seededPairStart)![index]!)!;
          const winner = winners.get(slotKey(band.playOffSeededPairStart, side))!;
          return makeTie(band, side, seeded, winner.club.teamId);
        }),
      );
      return {
        ...drawResult(ties),
        source: 'simulated',
        lotSamplingAlgorithm: lots.algorithm,
        randomDraws: lots.randomDraws,
      };
    },

    fromOfficial(
      input: OfficialChampionsLeagueRoundOf16Draw,
    ): RecordedChampionsLeagueRoundOf16Draw {
      if ([...winners.values()].some((winner) => winner.source !== 'observed'))
        throw new RangeError(
          'official round of 16 requires observed play-off winners',
        );
      if (
        typeof input.sourceReference !== 'string' ||
        input.sourceReference.trim() === '' ||
        input.ties.length !== 8
      )
        throw new RangeError('official draw requires a source and all eight ties');
      const assigned = new Set<number>();
      const tiesBySlot = new Map<string, ChampionsLeagueRoundOf16Tie>();
      for (const tie of input.ties) {
        if (tie == null || !sides.includes(tie.side))
          throw new RangeError('official ties require valid bracket sides');
        const seeded = byTeam.get(tie.seededTeamId);
        const band = bands.find(
          ({ seededPairStart }) =>
            seeded?.position === seededPairStart ||
            seeded?.position === seededPairStart + 1,
        );
        if (
          seeded === undefined ||
          band === undefined ||
          assigned.has(seeded.teamId)
        )
          throw new RangeError(
            'official round of 16 requires each top-eight club once',
          );
        assigned.add(seeded.teamId);
        const expectedWinner = winners.get(
          slotKey(band.playOffSeededPairStart, tie.side),
        )!;
        const slot = slotKey(band.seededPairStart, tie.side);
        if (tie.winnerTeamId !== expectedWinner.club.teamId || tiesBySlot.has(slot))
          throw new RangeError(
            'official ties must match their inherited play-off slots',
          );
        const host = tie.firstLegHomeTeamId ?? null;
        if (host !== null && host !== seeded.teamId && host !== tie.winnerTeamId)
          throw new RangeError('the first leg host must belong to the tie');
        tiesBySlot.set(slot, makeTie(band, tie.side, seeded, host));
      }
      return {
        ...drawResult(
          bands.flatMap(({ seededPairStart }) =>
            sides.map((side) => tiesBySlot.get(slotKey(seededPairStart, side))!),
          ),
        ),
        source: 'official',
        sourceReference: input.sourceReference.trim(),
      };
    },
  };
}
