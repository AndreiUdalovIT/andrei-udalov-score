import { describe, expect, it } from 'vitest';

import { calculateExpectedGoals } from './expected-goals';
import type { LeagueAverages } from './league-averages';
import type { RegularizedVenueStrength } from './regularized-strengths';

const league: LeagueAverages = Object.freeze({
  matchCount: 20,
  effectiveMatchCount: 20,
  homeGoalsPerMatch: 2,
  awayGoalsPerMatch: 1,
});
const homeVenue: RegularizedVenueStrength = Object.freeze({
  matchCount: 4,
  effectiveMatchCount: 3,
  attack: 1.2,
  defence: 1.5,
  lowData: false,
});
const awayVenue: RegularizedVenueStrength = Object.freeze({
  matchCount: 5,
  effectiveMatchCount: 4,
  attack: 0.8,
  defence: 1.1,
  lowData: false,
});

describe('expected goals from venue strengths', () => {
  it('combines each attack with the opposing defence and correct league mean', () => {
    const result = calculateExpectedGoals(league, homeVenue, awayVenue);

    expect(result?.home).toBeCloseTo(2.64, 12);
    expect(result?.away).toBeCloseTo(1.2, 12);
    expect(result?.lowData).toBe(false);
  });

  it('retains neutral league means and carries either low-data flag', () => {
    expect(
      calculateExpectedGoals(
        league,
        { ...homeVenue, attack: 1, defence: 1 },
        { ...awayVenue, attack: 1, defence: 1 },
      ),
    ).toEqual({ home: 2, away: 1, lowData: false });
    expect(
      calculateExpectedGoals(league, { ...homeVenue, lowData: true }, awayVenue)
        ?.lowData,
    ).toBe(true);
    expect(
      calculateExpectedGoals(league, homeVenue, { ...awayVenue, lowData: true })
        ?.lowData,
    ).toBe(true);
  });

  it('returns null for missing league, venue or coefficient data', () => {
    expect(calculateExpectedGoals(null, homeVenue, awayVenue)).toBeNull();
    expect(calculateExpectedGoals(league, null, awayVenue)).toBeNull();
    expect(calculateExpectedGoals(league, homeVenue, null)).toBeNull();
    expect(
      calculateExpectedGoals(league, { ...homeVenue, attack: null }, awayVenue),
    ).toBeNull();
    expect(
      calculateExpectedGoals(league, { ...homeVenue, defence: null }, awayVenue),
    ).toBeNull();
    expect(
      calculateExpectedGoals(league, homeVenue, { ...awayVenue, attack: null }),
    ).toBeNull();
    expect(
      calculateExpectedGoals(league, homeVenue, { ...awayVenue, defence: null }),
    ).toBeNull();
  });

  it('keeps confirmed zero rates', () => {
    expect(
      calculateExpectedGoals(
        { ...league, homeGoalsPerMatch: 0, awayGoalsPerMatch: 0 },
        homeVenue,
        awayVenue,
      ),
    ).toEqual({ home: 0, away: 0, lowData: false });
    expect(
      calculateExpectedGoals(
        league,
        { ...homeVenue, attack: 0, defence: 0 },
        awayVenue,
      ),
    ).toEqual({ home: 0, away: 0, lowData: false });
  });

  it('rejects negative or non-finite factors for either rate', () => {
    for (const value of [-1, NaN, Infinity]) {
      expect(
        calculateExpectedGoals(
          { ...league, homeGoalsPerMatch: value },
          homeVenue,
          awayVenue,
        ),
      ).toBeNull();
      expect(
        calculateExpectedGoals(
          { ...league, awayGoalsPerMatch: value },
          homeVenue,
          awayVenue,
        ),
      ).toBeNull();
      expect(
        calculateExpectedGoals(league, { ...homeVenue, attack: value }, awayVenue),
      ).toBeNull();
      expect(
        calculateExpectedGoals(league, { ...homeVenue, defence: value }, awayVenue),
      ).toBeNull();
      expect(
        calculateExpectedGoals(league, homeVenue, { ...awayVenue, attack: value }),
      ).toBeNull();
      expect(
        calculateExpectedGoals(league, homeVenue, { ...awayVenue, defence: value }),
      ).toBeNull();
    }
  });

  it('balances extreme finite factors and rejects an overflowing final rate', () => {
    for (const sample of [
      { average: 1e300, attack: 1e100, defence: 1e-300, expected: 1e100 },
      { average: 1e-300, attack: 1e-100, defence: 1e300, expected: 1e-100 },
    ]) {
      const result = calculateExpectedGoals(
        { ...league, homeGoalsPerMatch: sample.average },
        { ...homeVenue, attack: sample.attack },
        { ...awayVenue, defence: sample.defence },
      );

      expect(result).not.toBeNull();
      expect(result!.home / sample.expected).toBeCloseTo(1, 12);
    }
    expect(
      calculateExpectedGoals(
        { ...league, homeGoalsPerMatch: 1e300 },
        { ...homeVenue, attack: 1e300 },
        awayVenue,
      ),
    ).toBeNull();
  });
});
