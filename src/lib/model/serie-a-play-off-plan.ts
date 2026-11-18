import type { RoundRobinMatchScore } from './round-robin-season';
import {
  rankSerieAPreliminaryTable,
  type SerieAPreliminaryPositionGroup,
  type SerieAPreliminaryRanking,
} from './serie-a-preliminary-ranking';
import type { SeasonStatsBaseline } from './season-stats';

export const SERIE_A_PLAY_OFF_PLAN_ALGORITHM = 'sa-title-survival-play-off-plan-v1';

const supportedSeasons: readonly number[] = [2023, 2024, 2025, 2026];

export type SerieAPlayOffSlot = {
  position: number;
  /** Candidates at this mini-table position; ID order is for display only. */
  candidateTeamIds: number[];
};

export type SerieAPlayOffEvent = {
  kind: 'title' | 'survival';
  points: number;
  /** All clubs in the original equal-points group, including non-participants. */
  pointsGroupTeamIds: number[];
  higherSlot: SerieAPlayOffSlot;
  lowerSlot: SerieAPlayOffSlot;
  selection:
    'ordered-pair-known' | 'pair-order-needs-draw' | 'participants-need-draw';
  decision:
    | 'play-off-required'
    | 'classifica-avulsa-applies'
    | 'uefa-finalists-required'
    | 'participant-draw-required';
  /** Normal format, used only if decision requires the play-off. */
  normalFormat: {
    legs: 1 | 2;
    firstLegHomeSlot: 'higher' | 'lower';
    secondLegHomeSlot: 'higher' | null;
    /** Legacy title games may move here if public-order authorities require it. */
    neutralVenueAlternative: 'coppa-italia-final-venue' | null;
    extraTime: false;
    awayGoals: false;
    /** At 90 minutes for one leg, or equal aggregate goals for two legs. */
    penaltiesOnTie: true;
  };
};

export type SerieAPlayOffPlan = {
  algorithm: typeof SERIE_A_PLAY_OFF_PLAN_ALGORITHM;
  season: number;
  scope: 'play-off-plan';
  /** Complete list of Serie A UEFA finalists in this scenario, or null if unknown. */
  uefaFinalistTeamIds: number[] | null;
  preliminary: SerieAPreliminaryRanking;
  events: SerieAPlayOffEvent[];
};

function decide(
  season: number,
  finalists: ReadonlySet<number> | null,
  higher: SerieAPreliminaryPositionGroup,
  lower: SerieAPreliminaryPositionGroup,
): SerieAPlayOffEvent['decision'] {
  if (season !== 2026) return 'play-off-required';
  if (finalists === null) return 'uefa-finalists-required';
  if (![...higher.teamIds, ...lower.teamIds].some((id) => finalists.has(id))) {
    return 'play-off-required';
  }
  const higherNonFinalists = higher.teamIds.filter(
    (id) => !finalists.has(id),
  ).length;
  const lowerNonFinalists = lower.teamIds.filter((id) => !finalists.has(id)).length;
  const sameGroup = higher.from === lower.from;
  const pairWithoutFinalist = sameGroup
    ? higherNonFinalists >= 2
    : higherNonFinalists > 0 && lowerNonFinalists > 0;
  return pairWithoutFinalist
    ? 'participant-draw-required'
    : 'classifica-avulsa-applies';
}

/**
 * Plan Serie A title (1/2) and survival (17/18) decisions for a full season.
 * FIGC CU 23/A, 214/A, 331/A and 244/A for seasons 2023/24 through 2026/27.
 * https://www.figc.it/media/274515/331-deroga-art-51-noif-determinazione-classifica-campionato-serie-a-ss-2025-2026.pdf
 * Normal formats omit extra time and away-goals weighting. Each tied score or
 * aggregate goes directly to penalties. The higher mini-table club hosts the
 * title game or the second survival leg, subject to legacy venue restrictions.
 * For 2026/27, a UEFA finalist among the actual pair replaces that event with
 * classifica avulsa. Null is unknown finalist context; [] is explicitly no finalists.
 * A partial draw may leave the exception conditional on the selected participants.
 * Candidate slots from the same unresolved group share one draw without replacement.
 * Shared candidate pools across events must reuse one consistent draw.
 * This function does not draw lots, select venues, play games or finalize the table.
 * Return null for an unavailable preliminary table; invalid inputs throw RangeError.
 */
export function planSerieAPlayOffs(
  rows: readonly Readonly<SeasonStatsBaseline>[],
  scores: readonly Readonly<RoundRobinMatchScore>[],
  season: number,
  uefaFinalistTeamIds: readonly number[] | null = null,
): SerieAPlayOffPlan | null {
  const preliminary = rankSerieAPreliminaryTable(rows, scores, season);
  if (preliminary === null || !supportedSeasons.includes(season)) return null;

  const roster = new Set(preliminary.groups.flatMap((group) => group.teamIds));
  const finalists = uefaFinalistTeamIds === null ? null : new Set<number>();
  if (uefaFinalistTeamIds !== null) {
    for (const id of uefaFinalistTeamIds) {
      if (!Number.isSafeInteger(id) || !roster.has(id) || finalists!.has(id)) {
        throw new RangeError(
          'UEFA finalists require unique IDs from the season roster',
        );
      }
      finalists!.add(id);
    }
  }
  const events: SerieAPlayOffEvent[] = [];
  for (const [kind, higherPosition, lowerPosition] of [
    ['title', 1, 2],
    ['survival', 17, 18],
  ] as const) {
    const at = (position: number) =>
      preliminary.groups.find(
        (group) => group.from <= position && position <= group.to,
      )!;
    const higher = at(higherPosition);
    const lower = at(lowerPosition);
    if (higher.points !== lower.points) continue;

    const union = new Set([...higher.teamIds, ...lower.teamIds]);
    const selection =
      higher.teamIds.length === 1 && lower.teamIds.length === 1
        ? 'ordered-pair-known'
        : union.size === 2
          ? 'pair-order-needs-draw'
          : 'participants-need-draw';
    events.push({
      kind,
      points: higher.points,
      pointsGroupTeamIds: preliminary.groups
        .filter((group) => group.points === higher.points)
        .flatMap((group) => group.teamIds)
        .sort((left, right) => left - right),
      higherSlot: {
        position: higherPosition,
        candidateTeamIds: [...higher.teamIds],
      },
      lowerSlot: { position: lowerPosition, candidateTeamIds: [...lower.teamIds] },
      selection,
      decision: decide(season, finalists, higher, lower),
      normalFormat: {
        legs: kind === 'title' ? 1 : 2,
        firstLegHomeSlot: kind === 'title' ? 'higher' : 'lower',
        secondLegHomeSlot: kind === 'title' ? null : 'higher',
        neutralVenueAlternative:
          kind === 'title' && season !== 2026 ? 'coppa-italia-final-venue' : null,
        extraTime: false,
        awayGoals: false,
        penaltiesOnTie: true,
      },
    });
  }

  return {
    algorithm: SERIE_A_PLAY_OFF_PLAN_ALGORITHM,
    season,
    scope: 'play-off-plan',
    uefaFinalistTeamIds:
      finalists === null ? null : [...finalists].sort((left, right) => left - right),
    preliminary,
    events,
  };
}
