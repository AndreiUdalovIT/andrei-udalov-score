import type {
  ChampionsLeagueQuarterFinalTie,
  RecordedChampionsLeagueQuarterFinalDraw,
  SimulatedChampionsLeagueQuarterFinalDraw,
} from './champions-league-quarter-final-draw';
import {
  CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM,
  copyChampionsLeagueQuarterFinalDraw,
  type ChampionsLeagueQuarterFinalSample,
} from './champions-league-quarter-final-simulation';
import { KNOCKOUT_SAMPLING_ALGORITHM } from './knockout-sampler';
import { createSeasonLotsSampler } from './season-lots-sampler';

export const CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM =
  'ucl-semi-final-bracket-paths-v1';

const sides = ['silver', 'blue'] as const;
type QuarterFinalSlot = Pick<
  ChampionsLeagueQuarterFinalTie,
  'seededPairStart' | 'side'
>;

type QuarterFinalWinner = {
  club: ChampionsLeagueQuarterFinalTie['first']['club'];
  slot: QuarterFinalSlot;
  source: 'observed' | 'simulated';
};

export type ChampionsLeagueSemiFinalTie = {
  side: QuarterFinalSlot['side'];
  /** Winners of the 1/2 and 3/4 quarter-final branches on this side, in that order. */
  first: QuarterFinalWinner;
  second: QuarterFinalWinner;
  firstLegHomeTeamId: number | null;
};

type SemiFinalDraw = {
  algorithm: typeof CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM;
  season: number;
  quarterFinalDraw: ChampionsLeagueQuarterFinalSample['draw'];
  /** Silver, then blue. */
  ties: ChampionsLeagueSemiFinalTie[];
};

export type RecordedChampionsLeagueSemiFinalDraw = SemiFinalDraw & {
  source: 'official';
  homeOrder: RecordedChampionsLeagueQuarterFinalDraw['homeOrder'];
};

export type SimulatedChampionsLeagueSemiFinalDraw = SemiFinalDraw & {
  source: 'simulated';
  homeOrder: SimulatedChampionsLeagueQuarterFinalDraw['homeOrder'];
};

export type OfficialChampionsLeagueSemiFinalHomeOrder = {
  readonly season: number;
  readonly sourceReference: string;
  readonly ties: readonly {
    readonly side: QuarterFinalSlot['side'];
    /** The first host's quarter-final branch. Null means order is unavailable. */
    readonly firstLegHomeFrom: QuarterFinalSlot['seededPairStart'] | null;
  }[];
};

function slotKey({ side, seededPairStart }: QuarterFinalSlot) {
  return side + ':' + seededPairStart;
}

/**
 * Join the two quarter-final winners on each side. Under the 2024/25 procedure
 * each side draws its home order separately. From 2025/26 the winner of the
 * 1/2 branch hosts the return leg under Article 19.04, regardless of its rank.
 * This follows the routes in the existing quarter-final draw.
 *
 * A published home order can be applied by feeder branch to an official
 * round-of-16 bracket before the quarter-final winners are known. Preserve
 * explicit reversals and unknown hosts. An official draw output requires
 * observed winners as well as the published order. The caller authenticates
 * those inputs and the cutoff.
 */
export function createChampionsLeagueSemiFinalDraw(
  quarterFinals: ChampionsLeagueQuarterFinalSample,
) {
  if (
    quarterFinals.algorithm !==
      CHAMPIONS_LEAGUE_QUARTER_FINAL_SIMULATION_ALGORITHM ||
    quarterFinals.knockoutAlgorithm !== KNOCKOUT_SAMPLING_ALGORITHM
  )
    throw new RangeError('semi-finals require a supported quarter-final sample');

  const { ties, ...quarterFinalDraw } = copyChampionsLeagueQuarterFinalDraw({
    ...quarterFinals.draw,
    ties: Array.from(quarterFinals.ties, (entry) => {
      if (entry == null)
        throw new RangeError('each quarter-final slot requires a result');
      return entry.tie;
    }),
  });
  const results = new Map(
    quarterFinals.ties.map(({ tie, result }) => [slotKey(tie), result]),
  );
  const winners = new Map<string, QuarterFinalWinner>();
  for (const tie of ties) {
    const result = results.get(slotKey(tie));
    if (
      result?.algorithm !== KNOCKOUT_SAMPLING_ALGORITHM ||
      result.legs.length !== 2 ||
      result.legs[0]?.leg !== 1 ||
      result.legs[1]?.leg !== 2
    )
      throw new RangeError(
        'each quarter-final slot requires a supported two-leg result',
      );

    const clubs = [tie.first.club, tie.second.club];
    const winner = clubs.find(({ teamId }) => teamId === result.winnerTeamId);
    const loser = clubs.find(({ teamId }) => teamId === result.loserTeamId);
    if (winner === undefined || loser === undefined || winner === loser)
      throw new RangeError(
        'the quarter-final winner and loser must belong to the tie',
      );

    const observed =
      quarterFinalDraw.source === 'official' &&
      result.legs.every((leg) => leg.source === 'known-result') &&
      (result.extraTime === null || result.extraTime.source === 'known-result') &&
      (result.shootout === null || result.shootout.source === 'known-result');
    winners.set(slotKey(tie), {
      club: { ...winner },
      slot: { seededPairStart: tie.seededPairStart, side: tie.side },
      source: observed ? 'observed' : 'simulated',
    });
  }

  const season = quarterFinalDraw.season;
  const pairs = sides.map((side) => ({
    side,
    first: winners.get(slotKey({ side, seededPairStart: 1 }))!,
    second: winners.get(slotKey({ side, seededPairStart: 3 }))!,
  }));
  const allWinnersObserved = [...winners.values()].every(
    (winner) => winner.source === 'observed',
  );
  // The 2024/25 draw chose paths before their winners were known.
  const sampler =
    season === 2024
      ? createSeasonLotsSampler(
          pairs.map((_, index) => {
            const from = 2 * index + 1;
            return { from, to: from + 1, teamIds: [from, from + 1] };
          }),
        )
      : null;

  function makeDraw(
    host: (pair: (typeof pairs)[number], index: number) => number | null,
  ): SemiFinalDraw {
    return {
      algorithm: CHAMPIONS_LEAGUE_SEMI_FINAL_DRAW_ALGORITHM,
      season,
      quarterFinalDraw: structuredClone(quarterFinalDraw),
      ties: pairs.map((pair, index) => ({
        ...structuredClone(pair),
        firstLegHomeTeamId: host(pair, index),
      })),
    };
  }

  return {
    sample(random: () => number): SimulatedChampionsLeagueSemiFinalDraw {
      if (sampler === null)
        return {
          ...makeDraw(({ second }) => second.club.teamId),
          source: 'simulated',
          homeOrder: { source: 'inherited-seeding' },
        };

      const lots = sampler.sample(random);
      return {
        ...makeDraw((pair, index) => {
          const order = lots.orders[index]!;
          return (order.teamIds[0] === order.from ? pair.first : pair.second).club
            .teamId;
        }),
        source: 'simulated',
        homeOrder: {
          source: 'simulated-lots',
          lotSamplingAlgorithm: lots.algorithm,
          randomDraws: lots.randomDraws,
        },
      };
    },

    withOfficialHomeOrder(
      input: OfficialChampionsLeagueSemiFinalHomeOrder,
    ): RecordedChampionsLeagueSemiFinalDraw | SimulatedChampionsLeagueSemiFinalDraw {
      if (
        quarterFinalDraw.roundOf16Draw.source !== 'official' ||
        input.season !== season ||
        typeof input.sourceReference !== 'string' ||
        input.sourceReference.trim() === '' ||
        input.ties.length !== pairs.length
      )
        throw new RangeError(
          'official home order requires a source and both sides of the published bracket for this season',
        );

      const hosts = new Map<QuarterFinalSlot['side'], number | null>();
      for (const order of input.ties) {
        const pair = pairs.find(({ side }) => side === order?.side);
        if (pair === undefined || hosts.has(pair.side))
          throw new RangeError(
            'official home order must cover each semi-final side once',
          );
        const feeder = order.firstLegHomeFrom;
        if (feeder === null) {
          hosts.set(pair.side, null);
          continue;
        }
        const host = [pair.first, pair.second].find(
          ({ slot }) => slot.seededPairStart === feeder,
        );
        if (host === undefined)
          throw new RangeError(
            'official home order must use a quarter-final branch on this side',
          );
        hosts.set(pair.side, host.club.teamId);
      }

      return {
        ...makeDraw(({ side }) => hosts.get(side) ?? null),
        source: allWinnersObserved ? 'official' : 'simulated',
        homeOrder: {
          source: 'official',
          sourceReference: input.sourceReference.trim(),
        },
      };
    },
  };
}
