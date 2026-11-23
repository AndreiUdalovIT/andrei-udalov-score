import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';

import {
  createSeasonLotsSampler,
  type SEASON_LOTS_SAMPLING_ALGORITHM,
} from './season-lots-sampler';

export const CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM =
  'ucl-play-off-ranked-bowls-v1';

export const CHAMPIONS_LEAGUE_PLAY_OFF_BANDS = [
  { seededPairStart: 9, unseededPairStart: 23 },
  { seededPairStart: 11, unseededPairStart: 21 },
  { seededPairStart: 13, unseededPairStart: 19 },
  { seededPairStart: 15, unseededPairStart: 17 },
] as const;

// UEFA starts with the unseeded 23/24 bowl and finishes with seeded 9/10.
const bowlOrder = [23, 21, 19, 17, 15, 13, 11, 9] as const;
const sides = ['silver', 'blue'] as const;

type SeededPairStart =
  (typeof CHAMPIONS_LEAGUE_PLAY_OFF_BANDS)[number]['seededPairStart'];
type BracketSide = (typeof sides)[number];
type BracketClub = { teamId: number; position: number };
type PlayOffBand = {
  seededPairStart: SeededPairStart;
  seeded: [BracketClub, BracketClub];
  unseeded: [BracketClub, BracketClub];
};

export type ChampionsLeaguePlayOffTie = {
  /** Together with side, this identifies the slot for the winner. */
  seededPairStart: SeededPairStart;
  side: BracketSide;
  seeded: BracketClub;
  unseeded: BracketClub;
  /** The other team hosts the return leg. Null means not supplied. */
  firstLegHomeTeamId: number | null;
};

export type OfficialChampionsLeaguePlayOffDraw = {
  /** Caller-provided reference to the published draw or bracket. */
  readonly sourceReference: string;
  readonly ties: readonly {
    readonly side: BracketSide;
    readonly seededTeamId: number;
    readonly unseededTeamId: number;
    readonly firstLegHomeTeamId?: number | null;
  }[];
};

type PlayOffDraw = {
  algorithm: typeof CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM;
  season: number;
  /** Canonical order: seeded pair starts 9/11/13/15, silver before blue. */
  ties: ChampionsLeaguePlayOffTie[];
};

export type SimulatedChampionsLeaguePlayOffDraw = PlayOffDraw & {
  source: 'simulated';
  lotSamplingAlgorithm: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
  randomDraws: number;
};

export type RecordedChampionsLeaguePlayOffDraw = PlayOffDraw & {
  source: 'official';
  sourceReference: string;
};

type RankingGroup = {
  readonly from: number;
  readonly to: number;
  readonly teamIds: readonly number[];
};

function compareTies(
  left: ChampionsLeaguePlayOffTie,
  right: ChampionsLeaguePlayOffTie,
) {
  return (
    left.seededPairStart - right.seededPairStart ||
    sides.indexOf(left.side) - sides.indexOf(right.side)
  );
}

/**
 * Prepare the standard 36-club format play-off draw under UEFA article 19.02.
 * Pass the complete final table of a known outcome or a ranking scenario.
 * Return null if a group leaves any of places 9–24 unresolved. Ties outside
 * those places may remain. Malformed rankings or draw records throw RangeError.
 *
 * Each bowl contains the two clubs at its specified league phase positions.
 * Sample each bowl without replacement using the supplied seeded random stream.
 * The first club goes to silver, the other to blue. Join the permitted seeded
 * and unseeded bowls on each side. For a simulated tie, use the standard
 * scenario of the seeded club at home in the return leg.
 *
 * For published draws, verify the full set against the standard bracket,
 * preserve the caller's source reference and each known home order. Leave an
 * unknown order null. Official inputs are not authenticated here; exceptions
 * to the allowed pairings or slots require a different bracket format.
 */
export function createChampionsLeaguePlayOffDraw(
  season: number,
  groups: readonly RankingGroup[],
) {
  if (!Number.isSafeInteger(season))
    throw new RangeError('season must be a safe integer');
  const format = getCompetitionSeasonConfig('CL', season);
  if (format?.format !== 'league-phase' || format.teamCount !== 36) return null;

  const slots = new Map<number, BracketClub>();
  const occupied = new Set<number>();
  const clubs = new Set<number>();
  for (const group of groups) {
    if (
      group == null ||
      !Number.isSafeInteger(group.from) ||
      !Number.isSafeInteger(group.to) ||
      group.from < 1 ||
      group.to > format.teamCount ||
      group.to < group.from ||
      group.teamIds.length !== group.to - group.from + 1
    )
      throw new RangeError('rank groups must match their league position ranges');

    group.teamIds.forEach((teamId) => {
      if (!Number.isSafeInteger(teamId) || teamId <= 0 || clubs.has(teamId))
        throw new RangeError('ranked clubs must have unique positive safe IDs');
      clubs.add(teamId);
    });
    for (let position = group.from; position <= group.to; position += 1) {
      if (occupied.has(position))
        throw new RangeError('rank groups cannot share league slots');
      occupied.add(position);
    }
    if (group.from === group.to)
      slots.set(group.from, { teamId: group.teamIds[0]!, position: group.from });
  }
  if (occupied.size !== format.teamCount || clubs.size !== format.teamCount)
    throw new RangeError('rank groups must cover the complete table');
  for (let position = 9; position <= 24; position += 1)
    if (!slots.has(position)) return null;

  const candidates: PlayOffBand[] = CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.map(
    ({ seededPairStart, unseededPairStart }) => ({
      seededPairStart,
      seeded: [slots.get(seededPairStart)!, slots.get(seededPairStart + 1)!],
      unseeded: [slots.get(unseededPairStart)!, slots.get(unseededPairStart + 1)!],
    }),
  );
  const clubById = new Map([...slots.values()].map((club) => [club.teamId, club]));
  const sampler = createSeasonLotsSampler(
    bowlOrder.map((start, index) => ({
      from: index * 2 + 1,
      to: index * 2 + 2,
      teamIds: [slots.get(start)!.teamId, slots.get(start + 1)!.teamId],
    })),
  );

  function buildTie(
    seededPairStart: SeededPairStart,
    side: BracketSide,
    seeded: BracketClub,
    unseeded: BracketClub,
    firstLegHomeTeamId: number | null,
  ): ChampionsLeaguePlayOffTie {
    return {
      seededPairStart,
      side,
      seeded: { ...seeded },
      unseeded: { ...unseeded },
      firstLegHomeTeamId,
    };
  }

  return {
    get candidateBands(): PlayOffBand[] {
      return structuredClone(candidates);
    },

    sample(random: () => number): SimulatedChampionsLeaguePlayOffDraw {
      const lots = sampler.sample(random);
      const orders = new Map(
        bowlOrder.map((start, index) => [start, lots.orders[index]!.teamIds]),
      );
      const ties = CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.flatMap(
        ({ seededPairStart, unseededPairStart }) =>
          sides.map((side, index) => {
            const seeded = clubById.get(orders.get(seededPairStart)![index]!)!;
            const unseeded = clubById.get(orders.get(unseededPairStart)![index]!)!;
            return buildTie(
              seededPairStart,
              side,
              seeded,
              unseeded,
              unseeded.teamId,
            );
          }),
      );
      return {
        algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
        season,
        source: 'simulated',
        lotSamplingAlgorithm: lots.algorithm,
        randomDraws: lots.randomDraws,
        ties,
      };
    },

    fromOfficial(
      input: OfficialChampionsLeaguePlayOffDraw,
    ): RecordedChampionsLeaguePlayOffDraw {
      if (
        typeof input.sourceReference !== 'string' ||
        input.sourceReference.trim() === '' ||
        input.ties.length !== CHAMPIONS_LEAGUE_PLAY_OFF_BANDS.length * sides.length
      )
        throw new RangeError('official draw requires a source and all eight ties');

      const assignedSlots = new Set<string>();
      const assignedClubs = new Set<number>();
      const ties = Array.from(input.ties, (tie) => {
        if (tie == null || !sides.includes(tie.side))
          throw new RangeError('each official tie must have a valid bracket side');
        const seeded = clubById.get(tie.seededTeamId);
        const unseeded = clubById.get(tie.unseededTeamId);
        const band = candidates.find(({ seeded: pool }) =>
          pool.some((club) => club.teamId === tie.seededTeamId),
        );
        if (
          band === undefined ||
          seeded === undefined ||
          unseeded === undefined ||
          !band.unseeded.some((club) => club.teamId === unseeded.teamId) ||
          assignedClubs.has(seeded.teamId) ||
          assignedClubs.has(unseeded.teamId)
        )
          throw new RangeError('official draw must use permitted opponents once');
        const slot = band.seededPairStart + ':' + tie.side;
        if (assignedSlots.has(slot))
          throw new RangeError('each draw band needs one tie per side');
        assignedSlots.add(slot);
        assignedClubs.add(seeded.teamId);
        assignedClubs.add(unseeded.teamId);
        const firstHome = tie.firstLegHomeTeamId ?? null;
        if (
          firstHome !== null &&
          firstHome !== seeded.teamId &&
          firstHome !== unseeded.teamId
        )
          throw new RangeError('the hosting club must belong to the tie');
        return buildTie(band.seededPairStart, tie.side, seeded, unseeded, firstHome);
      }).sort(compareTies);
      return {
        algorithm: CHAMPIONS_LEAGUE_PLAY_OFF_DRAW_ALGORITHM,
        season,
        source: 'official',
        sourceReference: input.sourceReference.trim(),
        ties,
      };
    },
  };
}
