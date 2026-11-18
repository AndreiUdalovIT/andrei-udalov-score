import { describe, expect, it } from 'vitest';

import { SEASON_LOTS_SAMPLING_ALGORITHM } from './season-lots-sampler';
import {
  planSerieAPlayOffs,
  type SerieAPlayOffEvent,
} from './serie-a-play-off-plan';
import {
  resolveSerieAPlayOffResult,
  SERIE_A_PLAY_OFF_RESULT_ALGORITHM,
  type SerieAPlayOffLegResult,
  type SerieAPlayOffShootoutResult,
} from './serie-a-play-off-result';
import { projectSeasonStats } from './season-stats';

function plan(
  finalists: readonly number[] | null = [],
  withLots = true,
  season = 2026,
) {
  const ids = Array.from({ length: 20 }, (_, index) => index + 1);
  const scores = ids.flatMap((homeTeamId) =>
    ids
      .filter((awayTeamId) => awayTeamId !== homeTeamId)
      .map((awayTeamId) => ({
        id: (homeTeamId - 1) * 20 + awayTeamId,
        homeTeamId,
        awayTeamId,
        homeGoals90: 1,
        awayGoals90: 0,
      })),
  );
  const initial = ids.map((teamId) => ({
    teamId,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  const rows = projectSeasonStats(
    initial,
    scores.map((score) => ({ ...score, source: 'simulated' as const })),
  )!.map((row) => ({
    ...row,
    points:
      row.teamId <= 2
        ? -1
        : row.teamId === 17 || row.teamId === 18
          ? -17
          : -row.teamId,
  }));
  return planSerieAPlayOffs(
    rows,
    scores,
    season,
    finalists,
    withLots
      ? {
          algorithm: SEASON_LOTS_SAMPLING_ALGORITHM,
          source: 'simulated-lots',
          randomDraws: 2,
          orders: [
            { from: 1, to: 2, teamIds: [1, 2] },
            { from: 17, to: 18, teamIds: [17, 18] },
          ],
        }
      : null,
  )!;
}

function event(
  kind: SerieAPlayOffEvent['kind'],
  finalists: readonly number[] | null = [],
  withLots = true,
  season = 2026,
) {
  return plan(finalists, withLots, season).events.find(
    (item) => item.kind === kind,
  )!;
}

function titleLeg(
  homeGoals90: number,
  awayGoals90: number,
  source: SerieAPlayOffLegResult['source'] = 'known-result',
): SerieAPlayOffLegResult {
  return { leg: 1, homeTeamId: 1, awayTeamId: 2, homeGoals90, awayGoals90, source };
}

function survivalLegs(
  firstHome: number,
  firstAway: number,
  secondHome: number,
  secondAway: number,
): SerieAPlayOffLegResult[] {
  return [
    {
      leg: 1,
      homeTeamId: 18,
      awayTeamId: 17,
      homeGoals90: firstHome,
      awayGoals90: firstAway,
      source: 'known-result',
    },
    {
      leg: 2,
      homeTeamId: 17,
      awayTeamId: 18,
      homeGoals90: secondHome,
      awayGoals90: secondAway,
      source: 'known-result',
    },
  ];
}

describe('Serie A play-off result resolution', () => {
  it.each([
    { goals: [2, 1], order: [1, 2] },
    { goals: [0, 1], order: [2, 1] },
    { goals: [Number.MAX_SAFE_INTEGER, 0], order: [1, 2] },
  ])(
    'assigns title positions from a single 90-minute score: %j',
    ({ goals, order }) => {
      const leg = titleLeg(goals[0]!, goals[1]!);
      const result = resolveSerieAPlayOffResult(event('title'), [leg])!;
      expect(SERIE_A_PLAY_OFF_RESULT_ALGORITHM).toBe(
        'sa-no-extra-time-play-off-result-v1',
      );
      expect(result.algorithm).toBe(SERIE_A_PLAY_OFF_RESULT_ALGORITHM);
      expect(result.kind).toBe('title');
      expect(result.method).toBe('regulation-goals');
      expect(result.higherSeedTeamId).toBe(1);
      expect(result.lowerSeedTeamId).toBe(2);
      expect(result.aggregateGoals90).toEqual({ higher: goals[0], lower: goals[1] });
      expect(result.placements).toEqual([
        { position: 1, teamId: order[0] },
        { position: 2, teamId: order[1] },
      ]);
      expect(result.legs).toEqual([leg]);
      expect(result.shootout).toBeNull();
    },
  );

  it.each([1, 2])(
    'uses the explicitly supplied shootout winner %s after a title draw',
    (winnerTeamId) => {
      const shootout: SerieAPlayOffShootoutResult = {
        winnerTeamId,
        source: 'simulated',
      };
      const result = resolveSerieAPlayOffResult(
        event('title'),
        [titleLeg(0, 0, 'simulated')],
        shootout,
      )!;
      expect(result.method).toBe('penalties');
      expect(result.aggregateGoals90).toEqual({ higher: 0, lower: 0 });
      expect(result.placements[0]!.teamId).toBe(winnerTeamId);
      expect(result.placements[1]!.teamId).toBe(winnerTeamId === 1 ? 2 : 1);
      expect(result.shootout).toEqual(shootout);
    },
  );

  it('waits for a shootout winner after a tied title game', () => {
    expect(resolveSerieAPlayOffResult(event('title'), [titleLeg(3, 3)])).toBeNull();
  });

  it.each([
    { goals: [1, 0, 2, 0], totals: [2, 1], order: [17, 18] },
    { goals: [2, 0, 0, 0], totals: [0, 2], order: [18, 17] },
  ])(
    'aggregates survival legs in team order after swapping hosts: %j',
    ({ goals, totals, order }) => {
      const result = resolveSerieAPlayOffResult(
        event('survival'),
        survivalLegs(...(goals as [number, number, number, number])),
      )!;
      expect(result.method).toBe('aggregate-goals');
      expect(result.kind).toBe('survival');
      expect(result.higherSeedTeamId).toBe(17);
      expect(result.lowerSeedTeamId).toBe(18);
      expect(result.aggregateGoals90).toEqual({
        higher: totals[0],
        lower: totals[1],
      });
      expect(result.placements).toEqual([
        { position: 17, teamId: order[0] },
        { position: 18, teamId: order[1] },
      ]);
    },
  );

  it('requires penalties at equal aggregate despite unequal away-goal totals', () => {
    const legs = survivalLegs(0, 1, 1, 2); // 2:2; lower seed has more away goals.
    expect(resolveSerieAPlayOffResult(event('survival'), legs)).toBeNull();
    const result = resolveSerieAPlayOffResult(event('survival'), legs, {
      winnerTeamId: 17,
      source: 'known-result',
    })!;
    expect(result.method).toBe('penalties');
    expect(result.aggregateGoals90).toEqual({ higher: 2, lower: 2 });
    expect(result.placements).toEqual([
      { position: 17, teamId: 17 },
      { position: 18, teamId: 18 },
    ]);
  });

  it('sorts copied legs by ordinal and keeps per-result known/simulated provenance', () => {
    const known = survivalLegs(0, 1, 1, 2);
    const legs = [{ ...known[1]!, source: 'simulated' as const }, known[0]!];
    const shootout = { winnerTeamId: 18, source: 'simulated' as const };
    const result = resolveSerieAPlayOffResult(event('survival'), legs, shootout)!;
    expect(result.legs.map((leg) => leg.leg)).toEqual([1, 2]);
    expect(result.legs.map((leg) => leg.source)).toEqual([
      'known-result',
      'simulated',
    ]);
    expect(result.shootout).toEqual(shootout);
    expect(legs.map((leg) => leg.leg)).toEqual([2, 1]);
    expect(
      resolveSerieAPlayOffResult(
        event('survival'),
        JSON.parse(JSON.stringify([...legs].reverse())),
        { ...shootout },
      ),
    ).toEqual(result);
  });

  it.each(['none', 'first', 'second'] as const)(
    'waits for the remaining survival legs: %s',
    (available) => {
      const legs = survivalLegs(1, 0, 2, 0);
      const supplied =
        available === 'none' ? [] : available === 'first' ? [legs[0]!] : [legs[1]!];
      expect(resolveSerieAPlayOffResult(event('survival'), supplied)).toBeNull();
    },
  );

  it('waits for an unplayed title game', () => {
    expect(resolveSerieAPlayOffResult(event('title'), [])).toBeNull();
  });

  it.each([
    { kind: 'title' as const, finalist: 1, order: [1, 2] },
    { kind: 'survival' as const, finalist: 18, order: [17, 18] },
  ])(
    'applies the UEFA waiver without fabricating a match: %j',
    ({ kind, finalist, order }) => {
      const result = resolveSerieAPlayOffResult(event(kind, [finalist]), [])!;
      expect(result.method).toBe('classifica-avulsa');
      expect(result.placements.map((item) => item.teamId)).toEqual(order);
      expect(result.aggregateGoals90).toBeNull();
      expect(result.legs).toEqual([]);
      expect(result.shootout).toBeNull();
    },
  );

  it('waits for a draw even when a known finalist already guarantees the waiver', () => {
    expect(resolveSerieAPlayOffResult(event('title', [1], false), [])).toBeNull();
  });

  it('waits for the selected pair instead of inferring its mini-table order from a score', () => {
    const unresolved = event('title', [], false);
    expect(resolveSerieAPlayOffResult(unresolved, [titleLeg(1, 0)])).toBeNull();
  });

  it('keeps unknown finalist context unresolved even with all match results', () => {
    expect(
      resolveSerieAPlayOffResult(event('title', null), [titleLeg(0, 0)], {
        winnerTeamId: 1,
        source: 'known-result',
      }),
    ).toBeNull();
  });

  it.each([2023, 2024, 2025])(
    'supports the legacy nominal title format in %s',
    (season) => {
      const result = resolveSerieAPlayOffResult(event('title', [1], true, season), [
        titleLeg(0, 1),
      ])!;
      expect(result.method).toBe('regulation-goals');
      expect(result.placements[0]!.teamId).toBe(2);
    },
  );

  it.each([
    { name: 'negative goals', patch: { homeGoals90: -1 } },
    { name: 'fractional goals', patch: { awayGoals90: 0.5 } },
    { name: 'non-finite goals', patch: { homeGoals90: Infinity } },
    { name: 'NaN goals', patch: { awayGoals90: NaN } },
    { name: 'unsafe goals', patch: { homeGoals90: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'foreign club', patch: { homeTeamId: 3 } },
    { name: 'same club', patch: { awayTeamId: 1 } },
    { name: 'unknown source', patch: { source: 'unknown' } },
    { name: 'wrong ordinal', patch: { leg: 2 } },
  ])('rejects invalid leg data: $name', ({ patch }) => {
    const leg = { ...titleLeg(1, 0), ...patch } as SerieAPlayOffLegResult;
    expect(() => resolveSerieAPlayOffResult(event('title'), [leg])).toThrow(
      RangeError,
    );
  });

  it('rejects repeated and missing leg elements', () => {
    const legs = survivalLegs(1, 0, 2, 0);
    expect(() =>
      resolveSerieAPlayOffResult(event('survival'), [legs[0]!, legs[0]!]),
    ).toThrow(RangeError);
    expect(() =>
      resolveSerieAPlayOffResult(
        event('survival'),
        Array<SerieAPlayOffLegResult>(2),
      ),
    ).toThrow(RangeError);
  });

  it('rejects legs whose home order contradicts the plan', () => {
    expect(() =>
      resolveSerieAPlayOffResult(event('title'), [
        { ...titleLeg(1, 0), homeTeamId: 2, awayTeamId: 1 },
      ]),
    ).toThrow(RangeError);
    const legs = survivalLegs(1, 0, 2, 0);
    expect(() =>
      resolveSerieAPlayOffResult(event('survival'), [
        { ...legs[0]!, homeTeamId: 17, awayTeamId: 18 },
        legs[1]!,
      ]),
    ).toThrow(RangeError);
  });

  it.each([
    { winnerTeamId: 3, source: 'known-result' },
    { winnerTeamId: 0, source: 'known-result' },
    { winnerTeamId: 1.5, source: 'known-result' },
    { winnerTeamId: NaN, source: 'known-result' },
    { winnerTeamId: 1, source: 'unknown' },
  ])('rejects invalid shootout data: %j', (input) => {
    expect(() =>
      resolveSerieAPlayOffResult(
        event('title'),
        [titleLeg(0, 0)],
        input as SerieAPlayOffShootoutResult,
      ),
    ).toThrow(RangeError);
  });

  it('rejects a shootout before all legs or after an unequal score', () => {
    expect(() =>
      resolveSerieAPlayOffResult(event('title'), [], {
        winnerTeamId: 1,
        source: 'known-result',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSerieAPlayOffResult(event('title'), [titleLeg(1, 0)], {
        winnerTeamId: 1,
        source: 'known-result',
      }),
    ).toThrow(RangeError);
    const legs = survivalLegs(1, 0, 2, 0);
    expect(() =>
      resolveSerieAPlayOffResult(event('survival'), [legs[0]!], {
        winnerTeamId: 17,
        source: 'known-result',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSerieAPlayOffResult(event('survival'), legs, {
        winnerTeamId: 17,
        source: 'known-result',
      }),
    ).toThrow(RangeError);
  });

  it('rejects match and shootout data for a waived event, including unresolved order', () => {
    expect(() =>
      resolveSerieAPlayOffResult(event('title', [1]), [titleLeg(0, 0)]),
    ).toThrow(RangeError);
    expect(() =>
      resolveSerieAPlayOffResult(event('title', [1]), [], {
        winnerTeamId: 1,
        source: 'known-result',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSerieAPlayOffResult(event('title', [1], false), [titleLeg(0, 0)]),
    ).toThrow(RangeError);
  });

  it.each(['higher', 'lower'] as const)(
    'rejects unsafe two-leg aggregate arithmetic for the %s seed',
    (side) => {
      const legs =
        side === 'higher'
          ? survivalLegs(0, Number.MAX_SAFE_INTEGER, 1, 0)
          : survivalLegs(Number.MAX_SAFE_INTEGER, 0, 0, 1);
      expect(() => resolveSerieAPlayOffResult(event('survival'), legs)).toThrow(
        RangeError,
      );
    },
  );

  it.each([
    { extraTime: true },
    { awayGoals: true },
    { penaltiesOnTie: false },
    { legs: 2 },
    { firstLegHomeSlot: 'lower' },
    { secondLegHomeSlot: 'higher' },
  ])(
    'rejects unsupported title formats instead of silently applying other rules: %j',
    (patch) => {
      const planned = event('title');
      const invalid = {
        ...planned,
        normalFormat: { ...planned.normalFormat, ...patch },
      } as SerieAPlayOffEvent;
      expect(() => resolveSerieAPlayOffResult(invalid, [])).toThrow(RangeError);
    },
  );

  it.each([{ ids: [] }, { ids: [1, 1] }, { ids: [0] }, { ids: [1.5] }])(
    'rejects invalid candidate pools: %j',
    ({ ids }) => {
      const planned = event('title');
      const invalid = {
        ...planned,
        higherSlot: { ...planned.higherSlot, candidateTeamIds: ids },
      };
      expect(() => resolveSerieAPlayOffResult(invalid, [])).toThrow(RangeError);
    },
  );

  it('rejects an ordered pair that names the same club twice', () => {
    const planned = event('title');
    expect(() =>
      resolveSerieAPlayOffResult(
        { ...planned, lowerSlot: { ...planned.lowerSlot, candidateTeamIds: [1] } },
        [],
      ),
    ).toThrow(RangeError);
  });

  it('preserves frozen inputs and returns independent placements, legs and shootout copies', () => {
    const planned = event('survival');
    Object.freeze(planned.higherSlot.candidateTeamIds);
    Object.freeze(planned.lowerSlot.candidateTeamIds);
    Object.freeze(planned.higherSlot);
    Object.freeze(planned.lowerSlot);
    Object.freeze(planned.normalFormat);
    Object.freeze(planned);
    const legs = Object.freeze(
      survivalLegs(0, 1, 1, 2).map((leg) => Object.freeze(leg)),
    );
    const shootout = Object.freeze({
      winnerTeamId: 18,
      source: 'simulated' as const,
    });
    const expected = resolveSerieAPlayOffResult(planned, legs, shootout)!;
    const result = resolveSerieAPlayOffResult(planned, legs, shootout)!;
    expect(result.legs[0]).not.toBe(legs[0]);
    expect(result.shootout).not.toBe(shootout);
    result.placements[0]!.teamId = 999;
    result.legs.pop();
    result.aggregateGoals90!.higher = 999;
    result.shootout = null;
    expect(planned.higherSlot.candidateTeamIds).toEqual([17]);
    expect(legs).toHaveLength(2);
    expect(shootout.winnerTeamId).toBe(18);
    expect(resolveSerieAPlayOffResult(planned, legs, shootout)).toEqual(expected);
    expect(expected.placements[0]!.teamId).toBe(18);
    expect(expected.legs).toHaveLength(2);
  });
});
