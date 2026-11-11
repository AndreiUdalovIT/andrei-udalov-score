import { describe, expect, it } from 'vitest';

import type { ModelMatch } from './matches';
import {
  calculateRegularizedTeamStrengths,
  type TeamStrengthPrior,
} from './regularized-strengths';

const before = new Date('2026-11-11T12:00:00Z');
const options = Object.freeze({
  halfLifeDays: 1,
  priorMatchCount: 3,
  minEffectiveMatchCount: 2,
});
const match: ModelMatch = {
  id: 1,
  status: 'FINISHED',
  utcDate: new Date('2026-11-10T12:00:00Z'),
  lastUpdated: new Date('2026-11-10T14:00:00Z'),
  homeTeamId: 1,
  awayTeamId: 2,
  homeGoals90: 4,
  awayGoals90: 0,
};

describe('regularized team strengths', () => {
  it('shrinks both venues toward neutral strength without mutating inputs', () => {
    const rows = Object.freeze([
      Object.freeze(match),
      Object.freeze({
        ...match,
        id: 2,
        homeTeamId: 2,
        awayTeamId: 1,
        homeGoals90: 0,
        awayGoals90: 2,
      }),
    ]);
    const team = calculateRegularizedTeamStrengths(
      Object.freeze([1]),
      rows,
      before,
      options,
    ).teams[0];
    const expected = {
      matchCount: 1,
      effectiveMatchCount: 1,
      attack: 1.25,
      defence: 0.75,
      lowData: true,
    };

    expect(team).toEqual({ teamId: 1, home: expected, away: expected });

    const strongerPrior = calculateRegularizedTeamStrengths([1], rows, before, {
      ...options,
      priorMatchCount: 7,
    }).teams[0];

    expect(strongerPrior?.home?.attack).toBe(1.125);
    expect(strongerPrior?.home?.defence).toBe(0.875);
  });

  it('uses effective match counts for shrinkage and the low-data boundary', () => {
    const rows = [
      match,
      {
        ...match,
        id: 2,
        utcDate: new Date('2026-11-09T12:00:00Z'),
        lastUpdated: new Date('2026-11-09T14:00:00Z'),
      },
      {
        ...match,
        id: 3,
        homeTeamId: 3,
        awayTeamId: 4,
        homeGoals90: 0,
        awayGoals90: 2,
      },
    ];
    const settings = { ...options, priorMatchCount: 1.8 };
    const home = calculateRegularizedTeamStrengths([1], rows, before, settings)
      .teams[0]?.home;

    expect(home?.matchCount).toBe(2);
    expect(home?.effectiveMatchCount).toBe(1.8);
    expect(home?.attack).toBeCloseTo(4 / 3, 12);
    expect(home?.defence).toBe(0.5);
    expect(home?.lowData).toBe(true);
    expect(
      calculateRegularizedTeamStrengths([1], rows, before, {
        ...settings,
        minEffectiveMatchCount: 1.8,
      }).teams[0]?.home?.lowData,
    ).toBe(false);
  });

  it('preserves missing venues and marks undefined coefficients as low data', () => {
    expect(calculateRegularizedTeamStrengths([1], [], before, options)).toEqual({
      league: null,
      teams: [{ teamId: 1, home: null, away: null }],
    });

    const result = calculateRegularizedTeamStrengths(
      [1],
      [{ ...match, homeGoals90: 0, awayGoals90: 0 }],
      before,
      { ...options, minEffectiveMatchCount: 1 },
    );

    expect(result.teams[0]).toEqual({
      teamId: 1,
      home: {
        matchCount: 1,
        effectiveMatchCount: 1,
        attack: null,
        defence: null,
        lowData: true,
      },
      away: null,
    });
  });

  it('mixes venue priors with observed data and keeps native sample counts', () => {
    const prior = Object.freeze({ attack: 0.8, defence: 1.5 });
    const priors = new Map<number, TeamStrengthPrior>([
      [1, Object.freeze({ home: prior, away: null })],
      [99, Object.freeze({ home: null, away: prior })],
    ]);
    const rows = Object.freeze([
      Object.freeze(match),
      Object.freeze({
        ...match,
        id: 2,
        homeTeamId: 2,
        awayTeamId: 1,
        homeGoals90: 0,
        awayGoals90: 2,
      }),
    ]);
    const result = calculateRegularizedTeamStrengths(
      Object.freeze([1, 99]),
      rows,
      before,
      options,
      priors,
    );

    expect(result.teams[0]?.home).toMatchObject({
      matchCount: 1,
      effectiveMatchCount: 1,
      lowData: true,
    });
    expect(result.teams[0]?.home?.attack).toBeCloseTo(1.1, 12);
    expect(result.teams[0]?.home?.defence).toBe(1.125);
    expect(result.teams[0]?.away?.attack).toBe(1.25);
    expect(result.teams[0]?.away?.defence).toBe(0.75);
    expect(result.teams[1]).toEqual({
      teamId: 99,
      home: null,
      away: {
        matchCount: 0,
        effectiveMatchCount: 0,
        attack: 0.8,
        defence: 1.5,
        lowData: true,
      },
    });
  });

  it('avoids cancellation with extreme but finite prior coefficients', () => {
    const result = calculateRegularizedTeamStrengths(
      [1],
      [
        match,
        {
          ...match,
          id: 2,
          homeTeamId: 2,
          awayTeamId: 1,
          homeGoals90: 0,
          awayGoals90: 2,
        },
      ],
      before,
      { ...options, priorMatchCount: Number.MIN_VALUE },
      new Map([
        [
          1,
          {
            home: { attack: Number.MAX_VALUE, defence: Number.MAX_VALUE },
            away: null,
          },
        ],
      ]),
    );

    expect(result.teams[0]?.home?.attack).toBeCloseTo(2, 12);
    expect(result.teams[0]?.home?.defence).toBeGreaterThan(0);
  });

  it('keeps undefined observed ratios when a prior is available', () => {
    const priors = new Map<number, TeamStrengthPrior>([
      [1, { home: { attack: 0.8, defence: 1.5 }, away: null }],
    ]);
    const result = calculateRegularizedTeamStrengths(
      [1],
      [{ ...match, homeGoals90: 0, awayGoals90: 0 }],
      before,
      options,
      priors,
    );

    expect(result.teams[0]?.home).toMatchObject({
      matchCount: 1,
      attack: null,
      defence: null,
      lowData: true,
    });
  });

  it('validates supplied priors even when the observed venue is empty', () => {
    for (const prior of [
      { attack: -1, defence: 1 },
      { attack: 1, defence: -1 },
      { attack: NaN, defence: 1 },
      { attack: 1, defence: Infinity },
    ]) {
      expect(() =>
        calculateRegularizedTeamStrengths(
          [1],
          [],
          before,
          options,
          new Map([[1, { home: prior, away: null }]]),
        ),
      ).toThrow(RangeError);
    }
  });

  it('validates configuration and cutoff even for empty samples', () => {
    for (const priorMatchCount of [0, -1, NaN, Infinity]) {
      expect(() =>
        calculateRegularizedTeamStrengths([], [], before, {
          ...options,
          priorMatchCount,
        }),
      ).toThrow(RangeError);
    }
    for (const minEffectiveMatchCount of [0, 0.5, NaN, Infinity]) {
      expect(() =>
        calculateRegularizedTeamStrengths([], [], before, {
          ...options,
          minEffectiveMatchCount,
        }),
      ).toThrow(RangeError);
    }

    expect(() =>
      calculateRegularizedTeamStrengths([], [], before, {
        ...options,
        halfLifeDays: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateRegularizedTeamStrengths([], [], new Date(NaN), options),
    ).toThrow(RangeError);
  });
});
