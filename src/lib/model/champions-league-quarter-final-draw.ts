import type { ChampionsLeagueRoundOf16Tie } from './champions-league-round-of-16-draw';
import {
  CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM,
  copyChampionsLeagueRoundOf16Draw,
  type ChampionsLeagueRoundOf16Sample,
} from './champions-league-round-of-16-simulation';
import { KNOCKOUT_SAMPLING_ALGORITHM } from './knockout-sampler';
import {
  createSeasonLotsSampler,
  type SEASON_LOTS_SAMPLING_ALGORITHM,
} from './season-lots-sampler';

export const CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM =
  'ucl-quarter-final-bracket-paths-v1';

// Use ranking bands, because UEFA's printed round-of-16 match numbers vary by season.
const bands = [
  { seededPairStart: 1, opponentPairStart: 7 },
  { seededPairStart: 3, opponentPairStart: 5 },
] as const;
const sides = ['silver', 'blue'] as const;

type RoundOf16Slot = Pick<ChampionsLeagueRoundOf16Tie, 'seededPairStart' | 'side'>;
type QuarterFinalSlot = {
  seededPairStart: (typeof bands)[number]['seededPairStart'];
  side: RoundOf16Slot['side'];
};

type RoundOf16Winner = {
  club: ChampionsLeagueRoundOf16Tie['seeded'];
  slot: RoundOf16Slot;
  source: 'observed' | 'simulated';
};

export type ChampionsLeagueQuarterFinalTie = QuarterFinalSlot & {
  /** The feeders from the 1/2 or 3/4 band and its opponent band, in that order. */
  first: RoundOf16Winner;
  second: RoundOf16Winner;
  firstLegHomeTeamId: number | null;
};

export type OfficialChampionsLeagueQuarterFinalHomeOrder = {
  readonly season: number;
  readonly sourceReference: string;
  readonly ties: readonly (Readonly<QuarterFinalSlot> & {
    /** The first host's round-of-16 band on this side. Null means order is unavailable. */
    readonly firstLegHomeFrom: RoundOf16Slot['seededPairStart'] | null;
  })[];
};

type OfficialHomeOrder = { source: 'official'; sourceReference: string };
type ScenarioHomeOrder =
  | {
      source: 'simulated-lots';
      lotSamplingAlgorithm: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
      randomDraws: number;
    }
  | { source: 'inherited-seeding' };

type QuarterFinalDraw = {
  algorithm: typeof CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM;
  season: number;
  roundOf16Draw: ChampionsLeagueRoundOf16Sample['draw'];
  /** Silver then blue, with the 1/2 branch before the 3/4 branch on each side. */
  ties: ChampionsLeagueQuarterFinalTie[];
};

export type RecordedChampionsLeagueQuarterFinalDraw = QuarterFinalDraw & {
  source: 'official';
  homeOrder: OfficialHomeOrder;
};

export type SimulatedChampionsLeagueQuarterFinalDraw = QuarterFinalDraw & {
  source: 'simulated';
  homeOrder: OfficialHomeOrder | ScenarioHomeOrder;
};

function slotKey({ seededPairStart, side }: RoundOf16Slot) {
  return seededPairStart + ':' + side;
}

/**
 * Pair the 1/2 branch with 7/8 and the 3/4 branch with 5/6 on each side.
 * Use the paths from the UEFA 2024/25 and 2025/26 procedures for the standard
 * 2026/27 scenario, with Article 19.04 governing the 2026/27 home order.
 * The 2024/25 scenario draws the home order once for each pair. From 2025/26
 * the first feeder's winner inherits the right to host the return leg.
 *
 * A published home order uses feeder slots, so it can also apply to future
 * winners from an official round-of-16 draw. Explicit reversals are preserved,
 * and unknown home orders stay null. The caller authenticates the evidence
 * and its cutoff. The draw is official only if every winner is observed and
 * the home-order record is supplied. Exceptional bracket changes are out of scope.
 */
export function createChampionsLeagueQuarterFinalDraw(
  roundOf16: ChampionsLeagueRoundOf16Sample,
) {
  if (
    roundOf16.algorithm !== CHAMPIONS_LEAGUE_ROUND_OF_16_SIMULATION_ALGORITHM ||
    roundOf16.knockoutAlgorithm !== KNOCKOUT_SAMPLING_ALGORITHM ||
    ![2024, 2025, 2026].includes(roundOf16.draw.season)
  )
    throw new RangeError('quarter-finals require a complete supported round of 16');

  const { ties, ...roundOf16Draw } = copyChampionsLeagueRoundOf16Draw({
    ...roundOf16.draw,
    ties: Array.from(roundOf16.ties, (entry) => {
      if (entry == null)
        throw new RangeError('each round-of-16 slot requires a result');
      return entry.tie;
    }),
  });
  const results = new Map(
    roundOf16.ties.map(({ tie, result }) => [slotKey(tie), result]),
  );
  const winners = new Map<string, RoundOf16Winner>();
  for (const tie of ties) {
    const { seededPairStart, side, seeded, playOffWinner } = tie;
    const result = results.get(slotKey(tie));
    if (
      result?.algorithm !== KNOCKOUT_SAMPLING_ALGORITHM ||
      result.legs.length !== 2 ||
      result.legs[0]?.leg !== 1 ||
      result.legs[1]?.leg !== 2
    )
      throw new RangeError(
        'each round-of-16 slot requires a supported two-leg result',
      );
    const clubs = [seeded, playOffWinner.club];
    const winner = clubs.find(({ teamId }) => teamId === result.winnerTeamId);
    const loser = clubs.find(({ teamId }) => teamId === result.loserTeamId);
    if (winner === undefined || loser === undefined || winner === loser)
      throw new RangeError(
        'the round-of-16 winner and loser must belong to the tie',
      );

    const observed =
      roundOf16Draw.source === 'official' &&
      result.legs.every((leg) => leg.source === 'known-result') &&
      (result.extraTime === null || result.extraTime.source === 'known-result') &&
      (result.shootout === null || result.shootout.source === 'known-result');
    winners.set(slotKey(tie), {
      club: { ...winner },
      slot: { seededPairStart, side },
      source: observed ? 'observed' : 'simulated',
    });
  }

  const pairs = sides.flatMap((side) =>
    bands.map(({ seededPairStart, opponentPairStart }) => ({
      side,
      seededPairStart,
      first: winners.get(slotKey({ seededPairStart, side }))!,
      second: winners.get(slotKey({ seededPairStart: opponentPairStart, side }))!,
    })),
  );
  const season = roundOf16Draw.season;
  const allWinnersObserved = [...winners.values()].every(
    (winner) => winner.source === 'observed',
  );
  // The 2024/25 bowls drew feeder slots before their winners were known.
  const sampler =
    season === 2024
      ? createSeasonLotsSampler(
          pairs.map((_, index) => {
            const from = 2 * index + 1;
            return { from, to: from + 1, teamIds: [from, from + 1] };
          }),
        )
      : null;

  function makeDraw(hosts: readonly (number | null)[]): QuarterFinalDraw {
    return {
      algorithm: CHAMPIONS_LEAGUE_QUARTER_FINAL_DRAW_ALGORITHM,
      season,
      roundOf16Draw: structuredClone(roundOf16Draw),
      ties: pairs.map((pair, index) => ({
        ...structuredClone(pair),
        firstLegHomeTeamId: hosts[index]!,
      })),
    };
  }

  return {
    sample(random: () => number): SimulatedChampionsLeagueQuarterFinalDraw {
      if (sampler === null)
        return {
          ...makeDraw(pairs.map(({ second }) => second.club.teamId)),
          source: 'simulated',
          homeOrder: { source: 'inherited-seeding' },
        };

      const lots = sampler.sample(random);
      return {
        ...makeDraw(
          lots.orders.map(({ from, teamIds }, index) => {
            const pair = pairs[index]!;
            return (teamIds[0] === from ? pair.first : pair.second).club.teamId;
          }),
        ),
        source: 'simulated',
        homeOrder: {
          source: 'simulated-lots',
          lotSamplingAlgorithm: lots.algorithm,
          randomDraws: lots.randomDraws,
        },
      };
    },

    withOfficialHomeOrder(
      input: OfficialChampionsLeagueQuarterFinalHomeOrder,
    ):
      | RecordedChampionsLeagueQuarterFinalDraw
      | SimulatedChampionsLeagueQuarterFinalDraw {
      if (
        roundOf16Draw.source !== 'official' ||
        input.season !== season ||
        typeof input.sourceReference !== 'string' ||
        input.sourceReference.trim() === '' ||
        input.ties.length !== pairs.length
      )
        throw new RangeError(
          'official home order requires a source and the four official bracket pairs for this season',
        );

      const bySlot = new Map(pairs.map((pair) => [slotKey(pair), pair]));
      const hosts = new Map<string, number | null>();
      for (const order of input.ties) {
        if (order == null)
          throw new RangeError(
            'official home order requires every quarter-final slot',
          );
        const slot = slotKey(order);
        const pair = bySlot.get(slot);
        if (pair === undefined || hosts.has(slot))
          throw new RangeError(
            'official home order must cover each quarter-final slot once',
          );
        const { firstLegHomeFrom } = order;
        if (firstLegHomeFrom === null) {
          hosts.set(slot, null);
          continue;
        }
        const host = [pair.first, pair.second].find(
          ({ slot }) => slot.seededPairStart === firstLegHomeFrom,
        );
        if (host === undefined)
          throw new RangeError('official home order must use a feeder for the pair');
        hosts.set(slot, host.club.teamId);
      }
      const draw = makeDraw(pairs.map((pair) => hosts.get(slotKey(pair))!));
      return {
        ...draw,
        source: allWinnersObserved ? 'official' : 'simulated',
        homeOrder: {
          source: 'official',
          sourceReference: input.sourceReference.trim(),
        },
      };
    },
  };
}
