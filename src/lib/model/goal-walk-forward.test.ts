import { describe, expect, it } from 'vitest';

import { calculateExpectedGoals } from './expected-goals';
import { scoreGoalForecasts } from './goal-validation';
import {
  buildWalkForwardGoalForecasts,
  type GoalForecastFixture,
} from './goal-walk-forward';
import type { ModelMatch } from './matches';
import { calculateRegularizedTeamStrengths } from './regularized-strengths';

const window = Object.freeze({
  from: new Date('2026-01-02T12:00:00Z'),
  until: new Date('2026-01-04T12:00:00Z'),
  resultsBefore: new Date('2026-01-05T12:00:00Z'),
});
const options = Object.freeze({
  halfLifeDays: 1,
  priorMatchCount: 3,
  minEffectiveMatchCount: 1,
});

function match(
  id: number,
  kickoff: string,
  overrides: Partial<ModelMatch> = {},
): ModelMatch {
  const utcDate = new Date(kickoff);
  return {
    id,
    status: 'FINISHED',
    utcDate,
    lastUpdated: new Date(utcDate.getTime() + 2 * 60 * 60 * 1000),
    homeTeamId: 1,
    awayTeamId: 2,
    homeGoals90: 2,
    awayGoals90: 1,
    ...overrides,
  };
}

function forecastFrom(matches: readonly ModelMatch[]) {
  return ({ homeTeamId, awayTeamId, before }: GoalForecastFixture) => {
    const strengths = calculateRegularizedTeamStrengths(
      [homeTeamId, awayTeamId],
      matches,
      before,
      options,
    );
    const home = strengths.teams.find((team) => team.teamId === homeTeamId);
    const away = strengths.teams.find((team) => team.teamId === awayTeamId);
    return calculateExpectedGoals(
      strengths.league,
      home?.home ?? null,
      away?.away ?? null,
    );
  };
}

describe('walk-forward goal forecasts', () => {
  it('selects the half-open window and available results in chronological ID order', async () => {
    const inputs = Object.freeze(
      [
        match(40, '2026-01-04T12:00:00Z'),
        match(30, '2026-01-03T12:00:00Z'),
        match(21, '2026-01-02T12:00:00Z'),
        match(20, '2026-01-02T12:00:00Z'),
        match(1, '2026-01-01T12:00:00Z'),
        match(31, '2026-01-03T12:00:00Z', { status: 'AWARDED' }),
        match(32, '2026-01-03T12:00:00Z', {
          lastUpdated: window.resultsBefore,
        }),
        match(33, '2026-01-03T12:00:00Z', { homeGoals90: null }),
      ].map((row) => Object.freeze(row)),
    );
    const requests: GoalForecastFixture[] = [];
    const events: string[] = [];
    const rows = await buildWalkForwardGoalForecasts(
      inputs,
      window,
      async (fixture) => {
        events.push('start ' + fixture.id);
        requests.push({ ...fixture, before: new Date(fixture.before.getTime()) });
        fixture.before.setUTCFullYear(2000);
        await Promise.resolve();
        events.push('end ' + fixture.id);
        return { home: 2, away: 1, lowData: false };
      },
    );

    expect(rows.map((row) => row.id)).toEqual([20, 21, 30]);
    expect(requests.map((fixture) => fixture.id)).toEqual([20, 21, 30]);
    expect(events).toEqual([
      'start 20',
      'end 20',
      'start 21',
      'end 21',
      'start 30',
      'end 30',
    ]);
    expect(Object.keys(requests[0]!).sort()).toEqual([
      'awayTeamId',
      'before',
      'homeTeamId',
      'id',
    ]);
    expect(rows.map((row) => row.before)).toEqual(
      requests.map((fixture) => fixture.before),
    );
    expect(inputs[3]?.utcDate).toEqual(window.from);
    expect(rows[0]).toMatchObject({ homeGoals90: 2, awayGoals90: 1 });
  });

  it('excludes the target, simultaneous games, future games and later updates from training', async () => {
    const inputs = [
      match(1, '2026-01-01T12:00:00Z'),
      match(2, '2026-01-01T16:00:00Z', {
        homeGoals90: 20,
        lastUpdated: window.from,
      }),
      match(3, '2026-01-01T18:00:00Z', {
        awayGoals90: 20,
        lastUpdated: new Date('2026-01-02T13:00:00Z'),
      }),
      match(20, '2026-01-02T12:00:00Z', { homeGoals90: 8, awayGoals90: 6 }),
      match(21, '2026-01-02T12:00:00Z', { homeGoals90: 0, awayGoals90: 0 }),
      match(30, '2026-01-03T12:00:00Z', { homeGoals90: 50, awayGoals90: 50 }),
    ];
    const period = { ...window, until: new Date('2026-01-03T12:00:00Z') };
    const rows = await buildWalkForwardGoalForecasts(
      inputs,
      period,
      forecastFrom(inputs),
    );

    expect(rows.map((row) => row.expectedGoals)).toEqual([
      { home: 2, away: 1, lowData: false },
      { home: 2, away: 1, lowData: false },
    ]);
    const changed = inputs.map((row) =>
      row.id >= 20 ? { ...row, homeGoals90: 99, awayGoals90: 99 } : row,
    );
    const repeated = await buildWalkForwardGoalForecasts(
      changed,
      period,
      forecastFrom(changed),
    );
    expect(repeated.map((row) => row.expectedGoals)).toEqual(
      rows.map((row) => row.expectedGoals),
    );
  });

  it('uses earlier validation results once their update precedes a later kickoff', async () => {
    const inputs = [
      match(1, '2026-01-01T12:00:00Z'),
      match(20, '2026-01-02T12:00:00Z', { homeGoals90: 8, awayGoals90: 6 }),
      match(30, '2026-01-03T12:00:00Z'),
    ];
    const rows = await buildWalkForwardGoalForecasts(
      inputs,
      window,
      forecastFrom(inputs),
    );

    expect(rows[0]?.expectedGoals).toEqual({ home: 2, away: 1, lowData: false });
    expect(rows[1]?.expectedGoals?.home).toBeCloseTo(6, 12);
    expect(rows[1]?.expectedGoals?.away).toBeCloseTo(13 / 3, 12);
  });

  it('retains unavailable forecasts and returns an empty sample without calls', async () => {
    const inputs = [
      match(20, '2026-01-02T12:00:00Z'),
      match(30, '2026-01-03T12:00:00Z'),
    ];
    const rows = await buildWalkForwardGoalForecasts(inputs, window, () => null);
    expect(scoreGoalForecasts(rows)).toEqual({
      matchCount: 2,
      forecastCount: 0,
      lowDataCount: 0,
      meanPoissonDeviance: null,
    });
    expect(
      await buildWalkForwardGoalForecasts([], window, () => {
        throw new Error('unexpected forecast');
      }),
    ).toEqual([]);
  });

  it('rejects invalid windows and duplicate validation IDs before forecasting', async () => {
    const sample = match(20, '2026-01-02T12:00:00Z');
    const forecast = () => {
      throw new Error('unexpected forecast');
    };
    for (const invalid of [
      { ...window, from: new Date(NaN) },
      { ...window, until: new Date(NaN) },
      { ...window, until: window.from },
      { ...window, from: window.until, until: window.from },
      { ...window, resultsBefore: new Date(NaN) },
    ]) {
      await expect(
        buildWalkForwardGoalForecasts([sample], invalid, forecast),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      buildWalkForwardGoalForecasts([sample, sample], window, forecast),
    ).rejects.toThrow('validation match IDs must be unique');
  });

  it('propagates forecasting failures without returning a partial sample', async () => {
    const calls: number[] = [];
    const failure = new Error('forecast unavailable');
    await expect(
      buildWalkForwardGoalForecasts(
        [match(20, '2026-01-02T12:00:00Z'), match(30, '2026-01-03T12:00:00Z')],
        window,
        ({ id }) => {
          calls.push(id);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(calls).toEqual([20]);
  });
});
