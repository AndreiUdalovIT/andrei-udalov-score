import { describe, expect, it } from 'vitest';

import type { ModelMatch } from './matches';
import { calculatePromotedTeamStrengths } from './promoted-strengths';

const before = new Date('2026-11-12T12:00:00Z');
const options = Object.freeze({
  halfLifeDays: 1,
  priorMatchCount: 1,
  minEffectiveMatchCount: 1,
});
const adjustment = Object.freeze({
  home: Object.freeze({ teamCount: 2, attack: 0.8, defence: 1.4 }),
  away: Object.freeze({ teamCount: 2, attack: 0.7, defence: 1.6 }),
});

function match(
  id: number,
  day: string,
  homeTeamId: number,
  awayTeamId: number,
  homeGoals90: number,
  awayGoals90: number,
): ModelMatch {
  return Object.freeze({
    id,
    status: 'FINISHED',
    utcDate: new Date(`${day}T12:00:00Z`),
    lastUpdated: new Date(`${day}T14:00:00Z`),
    homeTeamId,
    awayTeamId,
    homeGoals90,
    awayGoals90,
  });
}

const championship = Object.freeze([
  match(1, '2026-05-01', 1, 3, 4, 1),
  match(2, '2026-05-01', 2, 4, 2, 1),
  match(3, '2026-05-01', 3, 1, 1, 2),
  match(4, '2026-05-01', 4, 2, 1, 4),
]);
const history = Object.freeze([
  match(10, '2026-05-01', 3, 4, 2, 1),
  match(11, '2026-05-01', 4, 3, 2, 1),
]);
const recent = Object.freeze([
  ...history,
  match(12, '2026-11-10', 1, 3, 4, 0),
  match(13, '2026-11-10', 4, 2, 0, 2),
]);
const moreRecent = Object.freeze([
  ...recent,
  match(14, '2026-11-09', 1, 4, 4, 0),
  match(15, '2026-11-09', 3, 2, 0, 2),
]);

describe('promoted team strengths', () => {
  it('applies ELC corrections and retains PL and ELC sample counts separately', () => {
    const result = calculatePromotedTeamStrengths(
      Object.freeze([1, 99, 1]),
      championship,
      history,
      before,
      adjustment,
      options,
    );
    const team = result.teams[0];

    expect(result.league?.homeGoalsPerMatch).toBe(2);
    expect(result.league?.awayGoalsPerMatch).toBe(1);
    expect(result.teams.map((row) => row.teamId)).toEqual([1, 99]);
    expect(team?.home).toMatchObject({
      matchCount: 0,
      effectiveMatchCount: 0,
      lowData: true,
      championshipPrior: { matchCount: 1, effectiveMatchCount: 1 },
    });
    expect(team?.home?.attack).toBeCloseTo(1.2, 12);
    expect(team?.home?.defence).toBeCloseTo(1.05, 12);
    expect(team?.away?.attack).toBeCloseTo(0.7, 12);
    expect(team?.away?.defence).toBeCloseTo(1.2, 12);
    expect(result.teams[1]).toEqual({ teamId: 99, home: null, away: null });
  });

  it('reduces the ELC prior influence as effective PL evidence grows', () => {
    const first = calculatePromotedTeamStrengths(
      [1],
      championship,
      recent,
      before,
      adjustment,
      options,
    ).teams[0];
    const later = calculatePromotedTeamStrengths(
      [1],
      championship,
      moreRecent,
      before,
      adjustment,
      options,
    ).teams[0];

    expect(first?.home?.matchCount).toBe(1);
    expect(first?.home?.attack).toBeCloseTo(1.6, 12);
    expect(first?.home?.defence).toBeCloseTo(0.525, 12);
    expect(first?.home?.lowData).toBe(false);
    expect(later?.home?.matchCount).toBe(2);
    expect(later?.home?.effectiveMatchCount).toBe(1.8);
    expect(later?.home?.attack).toBeCloseTo(12 / 7, 12);
    expect(later?.home?.defence).toBeCloseTo(0.375, 12);
    expect(later?.home?.championshipPrior).toEqual(first?.home?.championshipPrior);
    expect(later?.away?.matchCount).toBe(0);
    expect(later?.away?.lowData).toBe(true);
  });

  it('requires sufficient PL evidence when ELC history or adjustment is missing', () => {
    const settings = { ...options, minEffectiveMatchCount: 1.8 };
    const absent = { teamId: 1, home: null, away: null };

    expect(
      calculatePromotedTeamStrengths(
        [1],
        championship,
        recent,
        before,
        adjustment,
        settings,
      ).teams[0],
    ).toEqual(absent);
    const withoutAdjustment = calculatePromotedTeamStrengths(
      [1],
      championship,
      moreRecent,
      before,
      null,
      settings,
    );
    const withoutHistory = calculatePromotedTeamStrengths(
      [1],
      [],
      moreRecent,
      before,
      adjustment,
      settings,
    );

    expect(withoutHistory).toEqual(withoutAdjustment);
    expect(withoutHistory.teams[0]?.home?.attack).toBeCloseTo(23 / 14, 12);
    expect(withoutHistory.teams[0]?.home?.defence).toBeCloseTo(5 / 14, 12);
    expect(withoutHistory.teams[0]?.home?.lowData).toBe(false);
    expect(withoutHistory.teams[0]?.home?.championshipPrior).toBeNull();
    expect(withoutHistory.teams[0]?.away).toBeNull();
  });

  it('handles absent or unusable correction factors independently per venue', () => {
    for (const attack of [null, 0, -1, NaN, Infinity]) {
      const result = calculatePromotedTeamStrengths(
        [1],
        championship,
        history,
        before,
        { ...adjustment, home: { ...adjustment.home, attack } },
        options,
      );

      expect(result.teams[0]?.home).toBeNull();
      expect(result.teams[0]?.away?.attack).toBeCloseTo(0.7, 12);
    }
  });

  it('applies the cutoff to both leagues before deriving prior and observed strengths', () => {
    const futureUpdate = {
      ...match(16, '2026-11-11', 1, 2, 99, 99),
      lastUpdated: before,
    };
    const cold = calculatePromotedTeamStrengths(
      [1],
      championship,
      history,
      before,
      adjustment,
      options,
    );

    expect(
      calculatePromotedTeamStrengths(
        [1],
        championship,
        [...history, futureUpdate],
        before,
        adjustment,
        options,
      ),
    ).toEqual(cold);
    const updatedHistory = championship.map((row) =>
      row.id === 1 ? { ...row, lastUpdated: before } : row,
    );
    const missingHome = calculatePromotedTeamStrengths(
      [1],
      updatedHistory,
      history,
      before,
      adjustment,
      options,
    );

    expect(missingHome.teams[0]?.home).toBeNull();
    expect(missingHome.teams[0]?.away).not.toBeNull();
  });
});
