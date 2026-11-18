export const SEASON_LOTS_SAMPLING_ALGORITHM =
  'position-ordered-fisher-yates-u53-rejection128-v1';

const randomScale = 2 ** 53;
const maximumAttemptsPerChoice = 128;

export type SeasonLotGroup = {
  readonly from: number;
  readonly to: number;
  readonly teamIds: readonly number[];
};

export type SimulatedSeasonLots = {
  algorithm: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
  source: 'simulated-lots';
  /** Includes rejected random numerators. */
  randomDraws: number;
  /** Team IDs are ordered by their assigned positions from from through to. */
  orders: { from: number; to: number; teamIds: number[] }[];
};

export type SeasonLotsSampler = {
  readonly algorithm: typeof SEASON_LOTS_SAMPLING_ALGORITHM;
  readonly groupCount: number;
  /** One accepted choice per Fisher-Yates swap; rejection can consume more. */
  readonly minimumRandomDraws: number;
  readonly sample: (random: () => number) => SimulatedSeasonLots;
};

/**
 * Prepare disjoint groups whose remaining positions may be decided by a draw.
 * The caller determines draw eligibility; missing data is not permission to draw.
 * Copy groups in position order and members in team ID order before sampling.
 * One permutation assigns all positions in each group, including shared slots
 * in different play-off events. Uniform drawing is a simulation assumption.
 * random must return k / 2^53 in [0,1), as createSeededRandom does.
 * Rejection leaves equal-sized residue classes for each bounded choice, assuming
 * uniform independent random numerators. It does not certify the PRNG's distribution.
 * Each bounded choice has at most 128 attempts; invalid or stuck random sources
 * throw RangeError. A failed sample can consume random values but returns no orders.
 * Reproduction needs the same seed, PRNG version, sampling version and call order.
 * Return fresh simulated orders; official draw results require a separate input.
 */
export function createSeasonLotsSampler(
  groups: readonly SeasonLotGroup[],
): SeasonLotsSampler {
  const seenTeams = new Set<number>();
  let previousEnd = 0;
  let minimumRandomDraws = 0;
  const prepared = [...groups]
    .sort((left, right) => left.from - right.from)
    .map((group) => {
      const ids = Array.from(group.teamIds);
      const end = group.from + (ids.length - 1);
      if (
        !Number.isSafeInteger(group.from) ||
        group.from <= 0 ||
        !Number.isSafeInteger(group.to) ||
        !Number.isSafeInteger(end) ||
        end !== group.to ||
        ids.length < 2 ||
        group.from <= previousEnd
      ) {
        throw new RangeError(
          'draw groups require valid disjoint position ranges and at least two clubs',
        );
      }
      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0 || seenTeams.has(id)) {
          throw new RangeError(
            'draw groups require globally unique positive safe team IDs',
          );
        }
        seenTeams.add(id);
      }
      previousEnd = group.to;
      minimumRandomDraws += ids.length - 1;
      if (!Number.isSafeInteger(minimumRandomDraws)) {
        throw new RangeError('draw count exceeds the safe integer range');
      }
      return {
        from: group.from,
        to: group.to,
        teamIds: ids.sort((left, right) => left - right),
      };
    });

  return {
    algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
    groupCount: prepared.length,
    minimumRandomDraws,
    sample(random) {
      let randomDraws = 0;
      function choose(bound: number): number {
        const limit = randomScale - (randomScale % bound);
        for (let attempt = 0; attempt < maximumAttemptsPerChoice; attempt += 1) {
          const value = random();
          randomDraws += 1;
          const numerator = value * randomScale;
          if (
            !Number.isSafeInteger(randomDraws) ||
            !Number.isFinite(value) ||
            value < 0 ||
            value >= 1 ||
            !Number.isSafeInteger(numerator)
          ) {
            throw new RangeError('random must return a 53-bit fraction in [0,1)');
          }
          if (numerator < limit) return numerator % bound;
        }
        throw new RangeError(
          'random source exceeded the bounded-choice rejection limit',
        );
      }

      const orders = prepared.map((group) => {
        const teamIds = [...group.teamIds];
        for (let index = teamIds.length - 1; index > 0; index -= 1) {
          const other = choose(index + 1);
          [teamIds[index], teamIds[other]] = [teamIds[other]!, teamIds[index]!];
        }
        return { from: group.from, to: group.to, teamIds };
      });
      return {
        algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
        source: 'simulated-lots',
        randomDraws,
        orders,
      };
    },
  };
}
