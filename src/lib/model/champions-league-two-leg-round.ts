import {
  createKnockoutSampler,
  type KnockoutExtraTimeInput,
  type KnockoutLegInput,
  type KnockoutPenaltiesInput,
  type KnockoutSampler,
  type SampledKnockout,
} from './knockout-sampler';
import type { PoissonDistributionOptions } from './poisson-distribution';

type TeamPair = { readonly firstTeamId: number; readonly secondTeamId: number };

export type ChampionsLeagueTwoLegMatchInputs = TeamPair & {
  readonly legs: readonly KnockoutLegInput[];
  /** Goals or rates for the 30 minutes at the return leg's venue. */
  readonly extraTime: Exclude<KnockoutExtraTimeInput, { kind: 'none' }> | null;
  /** A forecast probability refers to firstTeamId. */
  readonly penalties: KnockoutPenaltiesInput | null;
};

type TwoLegTie<Slot, Tie> = TeamPair & {
  readonly slot: Slot;
  readonly tie: Tie;
  readonly firstLegHomeTeamId: number | null;
};

type BlockedTie<Slot> = Slot & {
  reason:
    'missing-match-inputs' | 'missing-extra-time' | 'knockout-sampler-unavailable';
};

export type ChampionsLeagueTwoLegPreparation<Slot, Sample> =
  | {
      readonly status: 'ready';
      /** Union bound for the round, excluding numeric/RNG resolution and model error. */
      readonly tailUpperBound: number;
      readonly sample: (random: () => number) => Sample;
    }
  | {
      readonly status: 'unavailable';
      readonly blockedTies: readonly BlockedTie<Slot>[];
    };

function pairKey({ firstTeamId, secondTeamId }: TeamPair) {
  return firstTeamId + ':' + secondTeamId;
}

/**
 * Prepare already validated and ordered bracket ties. Each match input
 * belongs to one drawn pair. Observations require an official draw and
 * chronological legs. The knockout sampler checks scores, rates, reversed
 * venues and conditional results. A tied aggregate requires extra time.
 */
export function prepareChampionsLeagueTwoLegRound<Slot extends object, Tie>(
  ties: readonly TwoLegTie<Slot, Tie>[],
  matches: readonly ChampionsLeagueTwoLegMatchInputs[],
  source: 'official' | 'simulated',
  sampling: Readonly<PoissonDistributionOptions>,
): ChampionsLeagueTwoLegPreparation<Slot, { tie: Tie; result: SampledKnockout }[]> {
  const pairs = new Set(ties.map(pairKey));
  const byPair = new Map<string, ChampionsLeagueTwoLegMatchInputs>();
  for (const match of matches) {
    if (match == null)
      throw new RangeError('match inputs cannot contain missing entries');
    const key = pairKey(match);
    if (!pairs.has(key) || byPair.has(key))
      throw new RangeError('match inputs must match unique ordered drawn pairs');
    byPair.set(key, match);
  }

  const blockedTies: BlockedTie<Slot>[] = [];
  const prepared: { tie: Tie; sampler: KnockoutSampler }[] = [];
  for (const drawn of ties) {
    const { firstTeamId, secondTeamId, firstLegHomeTeamId, slot, tie } = drawn;
    const input = byPair.get(pairKey(drawn));
    if (input === undefined) {
      blockedTies.push({ ...slot, reason: 'missing-match-inputs' });
      continue;
    }
    const first = input.legs.find((leg) => leg?.leg === 1);
    const second = input.legs.find((leg) => leg?.leg === 2);
    if (
      input.legs.length !== 2 ||
      first === undefined ||
      second === undefined ||
      (firstLegHomeTeamId !== null && first.homeTeamId !== firstLegHomeTeamId)
    )
      throw new RangeError('each pair needs two legs in the drawn home order');

    const extraTime: KnockoutExtraTimeInput = input.extraTime ?? { kind: 'none' };
    if (input.extraTime !== null && extraTime.kind === 'none')
      throw new RangeError('two-leg rounds require extra time on a tied aggregate');
    if (
      (second.kind === 'known-result' && first.kind !== 'known-result') ||
      (source === 'simulated' &&
        (first.kind === 'known-result' ||
          second.kind === 'known-result' ||
          extraTime.kind === 'known-result' ||
          input.penalties?.kind === 'known-result'))
    )
      throw new RangeError(
        'observed results require an official draw and chronological legs',
      );

    const sampler = createKnockoutSampler({
      firstTeamId,
      secondTeamId,
      legs: input.legs,
      extraTime,
      penalties: input.penalties ?? null,
      sampling,
    });
    const mayTieAt90 =
      first.kind !== 'known-result' ||
      second.kind !== 'known-result' ||
      first.homeGoals90 + second.awayGoals90 ===
        first.awayGoals90 + second.homeGoals90;
    if (input.extraTime === null && mayTieAt90)
      blockedTies.push({ ...slot, reason: 'missing-extra-time' });
    else if (sampler === null)
      blockedTies.push({ ...slot, reason: 'knockout-sampler-unavailable' });
    else prepared.push({ tie, sampler });
  }

  if (blockedTies.length > 0) return { status: 'unavailable', blockedTies };
  return {
    status: 'ready',
    tailUpperBound: Math.min(
      1,
      prepared.reduce((sum, { sampler }) => sum + sampler.tailUpperBound, 0),
    ),
    sample: (random) =>
      prepared.map(({ tie, sampler }) => ({
        tie: structuredClone(tie),
        result: sampler.sample(random),
      })),
  };
}
