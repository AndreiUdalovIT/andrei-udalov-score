import { describe, expect, it } from 'vitest';

import type { ModelMatch } from './matches';
import { estimatePromotionAdjustment } from './promotion-adjustment';

const before = new Date('2026-11-11T12:00:00Z');
const options = Object.freeze({
  halfLifeDays: 365,
  priorMatchCount: 1,
  minEffectiveMatchCount: 1,
  minTeamCount: 2,
});

function match(
  id: number,
  year: number,
  homeTeamId: number,
  awayTeamId: number,
  homeGoals90: number,
  awayGoals90: number,
): ModelMatch {
  return Object.freeze({
    id,
    status: 'FINISHED',
    utcDate: new Date(`${year}-05-01T12:00:00Z`),
    lastUpdated: new Date(`${year}-05-01T14:00:00Z`),
    homeTeamId,
    awayTeamId,
    homeGoals90,
    awayGoals90,
  });
}

const championship = Object.freeze([
  match(1, 2025, 1, 3, 4, 1),
  match(2, 2025, 2, 4, 2, 1),
  match(3, 2025, 3, 1, 1, 2),
  match(4, 2025, 4, 2, 1, 4),
]);
const premierLeague = Object.freeze([
  match(5, 2026, 1, 3, 1, 2),
  match(6, 2026, 2, 4, 1, 4),
  match(7, 2026, 3, 1, 4, 1),
  match(8, 2026, 4, 2, 2, 3),
]);

describe('promotion level adjustment', () => {
  it('pairs the same clubs and takes geometric means separately for each venue', () => {
    const result = estimatePromotionAdjustment(
      Object.freeze([2, 1, 2]),
      championship,
      premierLeague,
      before,
      options,
    );

    expect(result.home.teamCount).toBe(2);
    expect(result.away.teamCount).toBe(2);
    expect(result.home.attack).toBeCloseTo(Math.sqrt(3 / 8), 12);
    expect(result.home.defence).toBeCloseTo(Math.sqrt(52 / 25), 12);
    expect(result.away.attack).toBeCloseTo(Math.sqrt(77 / 150), 12);
    expect(result.away.defence).toBeCloseTo(Math.sqrt(8 / 3), 12);
  });

  it('requires enough reliable clubs per venue and retains eligible counts', () => {
    const homeOnly = premierLeague.slice(0, 2);
    const result = estimatePromotionAdjustment(
      [1, 2, 99],
      championship,
      homeOnly,
      before,
      options,
    );

    expect(result.home.teamCount).toBe(2);
    expect(result.home.attack).not.toBeNull();
    expect(result.away).toEqual({ teamCount: 0, attack: null, defence: null });
    expect(
      estimatePromotionAdjustment([1, 2], championship, homeOnly, before, {
        ...options,
        minTeamCount: 3,
      }).home,
    ).toEqual({ teamCount: 2, attack: null, defence: null });
    expect(
      estimatePromotionAdjustment([1, 2], championship, premierLeague, before, {
        ...options,
        minEffectiveMatchCount: 2,
      }),
    ).toEqual({
      home: { teamCount: 0, attack: null, defence: null },
      away: { teamCount: 0, attack: null, defence: null },
    });
  });

  it('excludes results whose latest update reaches the cutoff', () => {
    const updated = premierLeague.map((row) =>
      row.id === 5 ? { ...row, lastUpdated: before } : row,
    );
    const result = estimatePromotionAdjustment(
      [1, 2],
      championship,
      updated,
      before,
      options,
    );

    expect(result.home).toEqual({ teamCount: 1, attack: null, defence: null });
    expect(result.away.teamCount).toBe(2);
    expect(result.away.attack).not.toBeNull();
  });

  it('returns absent adjustments for empty samples and undefined league baselines', () => {
    const absent = {
      home: { teamCount: 0, attack: null, defence: null },
      away: { teamCount: 0, attack: null, defence: null },
    };
    const zeroScores = premierLeague.map((row) => ({
      ...row,
      homeGoals90: 0,
      awayGoals90: 0,
    }));

    expect(estimatePromotionAdjustment([1, 2], [], [], before, options)).toEqual(
      absent,
    );
    expect(
      estimatePromotionAdjustment([1, 2], championship, zeroScores, before, options),
    ).toEqual(absent);
  });

  it('validates thresholds, model options and cutoff even for empty cohorts', () => {
    for (const minTeamCount of [0, -1, 1.5, NaN, Infinity]) {
      expect(() =>
        estimatePromotionAdjustment([], [], [], before, {
          ...options,
          minTeamCount,
        }),
      ).toThrow(RangeError);
    }
    for (const invalid of [
      { halfLifeDays: 0 },
      { priorMatchCount: 0 },
      { minEffectiveMatchCount: 0 },
    ]) {
      expect(() =>
        estimatePromotionAdjustment([], [], [], before, {
          ...options,
          ...invalid,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      estimatePromotionAdjustment([], [], [], new Date(NaN), options),
    ).toThrow(RangeError);
  });
});
