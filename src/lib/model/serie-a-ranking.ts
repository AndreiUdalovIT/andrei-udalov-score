import type { RoundRobinMatchScore } from './round-robin-season';
import {
  planSerieAPlayOffs,
  type SerieAPlayOffEvent,
  type SerieAPlayOffLotsInput,
  type SerieAPlayOffPlan,
} from './serie-a-play-off-plan';
import {
  resolveSerieAPlayOffResult,
  type SerieAPlayOffLegResult,
  type SerieAPlayOffResult,
  type SerieAPlayOffShootoutResult,
} from './serie-a-play-off-result';
import type { SeasonStatsBaseline } from './season-stats';

export const SERIE_A_RANKING_ALGORITHM = 'sa-lots-and-play-offs-ranking-v1';

export type SerieAPlayOffOutcomeInput = {
  readonly kind: SerieAPlayOffEvent['kind'];
  readonly legs: readonly SerieAPlayOffLegResult[];
  readonly shootout?: Readonly<SerieAPlayOffShootoutResult> | null;
};

export type SerieAPositionGroup = {
  from: number;
  to: number;
  teamIds: [number];
  reason:
    | 'points'
    | 'classifica-avulsa'
    | 'simulated-lots'
    | 'title-play-off'
    | 'survival-play-off';
};

export type SerieASeasonRanking = {
  algorithm: typeof SERIE_A_RANKING_ALGORITHM;
  season: number;
  scope: 'after-play-offs';
  qualificationNote: string | null;
  /** Complete singleton groups in position order; no unresolved ranges. */
  groups: SerieAPositionGroup[];
  playOffPlan: SerieAPlayOffPlan;
  playOffResults: SerieAPlayOffResult[];
};

/**
 * Compose a complete Serie A classification from the existing planner/resolver.
 * Reconcile the full round-robin season, apply the supplied simulated lot orders
 * and then assign the title/survival positions from the supplied match results.
 * Missing input for a waived event is valid; the resolver keeps its mini-table
 * order. Preserve a simulated-lots reason if that order depended on a model draw.
 * Return null unless every position and required event is resolved, including
 * lot groups outside the play-offs and unknown finalist context where relevant.
 * Invalid or repeated event kinds, outcomes without a planned event and invalid
 * scores/lots throw RangeError through the existing validators.
 * Validate all supplied outcomes for an available plan, even if another event
 * or lot group remains unresolved. Null from preliminary reconciliation returns
 * before outcome validation, consistent with the planner's availability contract.
 * Play-off scores stay in the audit results and never alter league stats.
 * Consume no randomness; the caller supplies scores, shootouts and lots, and
 * retains the model, data-cutoff and known-result authenticity metadata.
 */
export function rankSerieASeason(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
  uefaFinalistTeamIds: readonly number[] | null = null,
  lots: SerieAPlayOffLotsInput | null = null,
  outcomes: readonly SerieAPlayOffOutcomeInput[] = [],
): SerieASeasonRanking | null {
  const plan = planSerieAPlayOffs(rows, scores, season, uefaFinalistTeamIds, lots);
  if (plan === null) return null;

  const scheduled = new Set(plan.events.map((event) => event.kind));
  const supplied = new Map<SerieAPlayOffEvent['kind'], SerieAPlayOffOutcomeInput>();
  for (const outcome of outcomes) {
    if (
      outcome === undefined ||
      outcome === null ||
      !scheduled.has(outcome.kind) ||
      supplied.has(outcome.kind)
    ) {
      throw new RangeError(
        'outcomes require unique kinds from the planned play-off events',
      );
    }
    supplied.set(outcome.kind, outcome);
  }

  let unavailable = false;
  const playOffResults: SerieAPlayOffResult[] = [];
  for (const event of plan.events) {
    const outcome = supplied.get(event.kind);
    const result = resolveSerieAPlayOffResult(
      event,
      outcome === undefined ? [] : outcome.legs,
      outcome?.shootout ?? null,
    );
    if (result === null) unavailable = true;
    else playOffResults.push(result);
  }

  const orders = new Map(
    plan.lots?.orders.map((order) => [order.from, order]) ?? [],
  );
  const groups: SerieAPositionGroup[] = [];
  for (const group of plan.preliminary.groups) {
    const ids =
      group.reason === 'drawing-of-lots-required'
        ? orders.get(group.from)?.teamIds
        : group.teamIds;
    if (ids === undefined) {
      unavailable = true;
      continue;
    }
    const reason =
      group.reason === 'drawing-of-lots-required' ? 'simulated-lots' : group.reason;
    ids.forEach((teamId, index) => {
      const position = group.from + index;
      groups.push({ from: position, to: position, teamIds: [teamId], reason });
    });
  }
  if (unavailable) return null;

  for (const result of playOffResults) {
    if (result.method === 'classifica-avulsa') continue;
    for (const placement of result.placements) {
      groups[placement.position - 1] = {
        from: placement.position,
        to: placement.position,
        teamIds: [placement.teamId],
        reason: result.kind === 'title' ? 'title-play-off' : 'survival-play-off',
      };
    }
  }

  return {
    algorithm: SERIE_A_RANKING_ALGORITHM,
    season,
    scope: 'after-play-offs',
    qualificationNote: plan.preliminary.qualificationNote,
    groups,
    playOffPlan: plan,
    playOffResults,
  };
}
