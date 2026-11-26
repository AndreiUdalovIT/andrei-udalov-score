import type { SerieAPlayOffEvent } from './serie-a-play-off-plan';

export const SERIE_A_PLAY_OFF_RESULT_ALGORITHM =
  'sa-no-extra-time-play-off-result-v1';

type ResultSource = 'known-result' | 'simulated';

export type SerieAPlayOffLegResult = {
  readonly leg: 1 | 2;
  readonly homeTeamId: number;
  readonly awayTeamId: number;
  readonly homeGoals90: number;
  readonly awayGoals90: number;
  readonly source: ResultSource;
};

export type SerieAPlayOffShootoutResult = {
  readonly winnerTeamId: number;
  readonly source: ResultSource;
};

export type SerieAPlayOffResult = {
  algorithm: typeof SERIE_A_PLAY_OFF_RESULT_ALGORITHM;
  kind: SerieAPlayOffEvent['kind'];
  method: 'classifica-avulsa' | 'regulation-goals' | 'aggregate-goals' | 'penalties';
  higherSeedTeamId: number;
  lowerSeedTeamId: number;
  /** Goals in 90 minutes, expressed in mini-table seed order; null if waived. */
  aggregateGoals90: { higher: number; lower: number } | null;
  /** Final occupants of the event's two positions, in position order. */
  placements: [
    { position: number; teamId: number },
    { position: number; teamId: number },
  ];
  legs: SerieAPlayOffLegResult[];
  shootout: SerieAPlayOffShootoutResult | null;
};

function isSource(source: ResultSource): boolean {
  return source === 'known-result' || source === 'simulated';
}

/**
 * Resolve one event produced by planSerieAPlayOffs from supplied leg results.
 * Use its normal format and nominal home order; this is not venue certification.
 * No extra time or away-goals weighting is supported. A tied score or aggregate
 * requires a separately supplied shootout winner, without a probability assumption.
 * Known and simulated leg/shootout provenance is copied independently.
 * Return null while participants, finalist context, legs or a required shootout
 * are unavailable. Classifica avulsa assigns the known mini-table order without
 * fabricating a match; supplying match/shootout results for that waiver is invalid.
 * A shootout supplied before both legs or after an unequal total is invalid.
 * This function consumes no randomness and does not update the league table.
 * Invalid IDs, scores, sources, leg order/participants, unsupported formats and
 * unsafe aggregate arithmetic throw RangeError. The caller retains season,
 * model/cutoff metadata and establishes the authenticity of known results.
 */
export function resolveSerieAPlayOffResult(
  event: Readonly<SerieAPlayOffEvent>,
  legs: readonly SerieAPlayOffLegResult[],
  shootout: Readonly<SerieAPlayOffShootoutResult> | null = null,
): SerieAPlayOffResult | null {
  const title = event.kind === 'title';
  const format = event.normalFormat;
  if (
    (!title && event.kind !== 'survival') ||
    event.higherSlot.position !== (title ? 1 : 17) ||
    event.lowerSlot.position !== (title ? 2 : 18) ||
    format.legs !== (title ? 1 : 2) ||
    format.firstLegHomeSlot !== (title ? 'higher' : 'lower') ||
    format.secondLegHomeSlot !== (title ? null : 'higher') ||
    format.extraTime !== false ||
    format.awayGoals !== false ||
    format.penaltiesOnTie !== true ||
    (format.neutralVenueAlternative !== null &&
      (!title || format.neutralVenueAlternative !== 'coppa-italia-final-venue')) ||
    ![
      'ordered-pair-known',
      'pair-order-needs-draw',
      'participants-need-draw',
    ].includes(event.selection) ||
    ![
      'play-off-required',
      'classifica-avulsa-applies',
      'uefa-finalists-required',
      'participant-draw-required',
    ].includes(event.decision)
  ) {
    throw new RangeError(
      'event must use the supported Serie A play-off positions and format',
    );
  }
  const higher = Array.from(event.higherSlot.candidateTeamIds);
  const lower = Array.from(event.lowerSlot.candidateTeamIds);
  for (const ids of [higher, lower]) {
    if (
      ids.length === 0 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new RangeError('candidate pools require unique positive safe team IDs');
    }
  }
  const ordered = event.selection === 'ordered-pair-known';
  if (
    ordered &&
    (higher.length !== 1 || lower.length !== 1 || higher[0] === lower[0])
  ) {
    throw new RangeError(
      'an ordered pair requires two distinct singleton candidates',
    );
  }
  const seenLegs = new Set<number>();
  const prepared = Array.from(legs, (leg) => {
    if (
      leg === undefined ||
      leg === null ||
      !Number.isSafeInteger(leg.leg) ||
      leg.leg < 1 ||
      leg.leg > format.legs ||
      seenLegs.has(leg.leg) ||
      !Number.isSafeInteger(leg.homeTeamId) ||
      leg.homeTeamId <= 0 ||
      !Number.isSafeInteger(leg.awayTeamId) ||
      leg.awayTeamId <= 0 ||
      leg.homeTeamId === leg.awayTeamId ||
      !Number.isSafeInteger(leg.homeGoals90) ||
      leg.homeGoals90 < 0 ||
      !Number.isSafeInteger(leg.awayGoals90) ||
      leg.awayGoals90 < 0 ||
      !isSource(leg.source)
    ) {
      throw new RangeError(
        'legs require unique scheduled ordinals, valid clubs, 90-minute goals and sources',
      );
    }
    seenLegs.add(leg.leg);
    const homeSlot =
      leg.leg === 1 ? format.firstLegHomeSlot : format.secondLegHomeSlot;
    const homePool = homeSlot === 'higher' ? higher : lower;
    const awayPool = homeSlot === 'higher' ? lower : higher;
    if (!homePool.includes(leg.homeTeamId) || !awayPool.includes(leg.awayTeamId)) {
      throw new RangeError(
        'leg participants must match the planned nominal home order',
      );
    }
    return {
      leg: leg.leg,
      homeTeamId: leg.homeTeamId,
      awayTeamId: leg.awayTeamId,
      homeGoals90: leg.homeGoals90,
      awayGoals90: leg.awayGoals90,
      source: leg.source,
    };
  }).sort((left, right) => left.leg - right.leg);

  if (
    shootout !== null &&
    (!Number.isSafeInteger(shootout.winnerTeamId) ||
      shootout.winnerTeamId <= 0 ||
      !isSource(shootout.source) ||
      (!higher.includes(shootout.winnerTeamId) &&
        !lower.includes(shootout.winnerTeamId)))
  ) {
    throw new RangeError('shootout requires a valid participant winner and source');
  }
  if (
    event.decision === 'classifica-avulsa-applies' &&
    (prepared.length !== 0 || shootout !== null)
  ) {
    throw new RangeError(
      'a classifica avulsa waiver cannot include play-off results',
    );
  }
  if (
    !ordered ||
    event.decision === 'uefa-finalists-required' ||
    event.decision === 'participant-draw-required'
  )
    return null;

  const higherTeamId = higher[0]!;
  const lowerTeamId = lower[0]!;
  const finish = (
    method: SerieAPlayOffResult['method'],
    firstTeamId: number,
    aggregateGoals90: SerieAPlayOffResult['aggregateGoals90'],
  ): SerieAPlayOffResult => ({
    algorithm: SERIE_A_PLAY_OFF_RESULT_ALGORITHM,
    kind: event.kind,
    method,
    higherSeedTeamId: higherTeamId,
    lowerSeedTeamId: lowerTeamId,
    aggregateGoals90,
    placements: [
      { position: event.higherSlot.position, teamId: firstTeamId },
      {
        position: event.lowerSlot.position,
        teamId: firstTeamId === higherTeamId ? lowerTeamId : higherTeamId,
      },
    ],
    legs: prepared,
    shootout:
      shootout === null
        ? null
        : { winnerTeamId: shootout.winnerTeamId, source: shootout.source },
  });

  if (event.decision === 'classifica-avulsa-applies') {
    return finish('classifica-avulsa', higherTeamId, null);
  }
  if (prepared.length !== format.legs) {
    if (shootout !== null)
      throw new RangeError('shootout requires every scheduled leg');
    return null;
  }

  let higherGoals = 0;
  let lowerGoals = 0;
  for (const leg of prepared) {
    const higherAtHome = leg.homeTeamId === higherTeamId;
    higherGoals += higherAtHome ? leg.homeGoals90 : leg.awayGoals90;
    lowerGoals += higherAtHome ? leg.awayGoals90 : leg.homeGoals90;
    if (!Number.isSafeInteger(higherGoals) || !Number.isSafeInteger(lowerGoals)) {
      throw new RangeError('aggregate goals exceed the safe integer range');
    }
  }
  const aggregateGoals90 = { higher: higherGoals, lower: lowerGoals };
  if (higherGoals !== lowerGoals) {
    if (shootout !== null)
      throw new RangeError('shootout requires tied 90-minute aggregate goals');
    return finish(
      title ? 'regulation-goals' : 'aggregate-goals',
      higherGoals > lowerGoals ? higherTeamId : lowerTeamId,
      aggregateGoals90,
    );
  }
  if (shootout === null) return null;
  return finish('penalties', shootout.winnerTeamId, aggregateGoals90);
}
