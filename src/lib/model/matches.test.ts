import { describe, expect, it } from 'vitest';

import { MATCH_STATUSES } from '@/lib/types/football';

import { selectTrainingMatches, type ModelMatch } from './matches';

const before = new Date('2026-11-11T12:00:00Z');
const match: ModelMatch = {
  id: 1,
  status: 'FINISHED',
  utcDate: new Date('2026-11-10T18:00:00Z'),
  lastUpdated: new Date('2026-11-10T20:00:00Z'),
  homeTeamId: 1,
  awayTeamId: 2,
  homeGoals90: 2,
  awayGoals90: 1,
};

describe('training match selection', () => {
  it('keeps complete results, including 0-0, in input order without mutation', () => {
    const rows = Object.freeze([
      Object.freeze({ ...match, id: 2, homeGoals90: 0, awayGoals90: 0 }),
      Object.freeze(match),
    ]);

    const selected = selectTrainingMatches(rows, before);

    expect(selected).toEqual(rows);
    expect(selected).not.toBe(rows);
  });

  it('excludes other statuses, unknown participants and incomplete scores', () => {
    const ignored: ModelMatch[] = [
      ...MATCH_STATUSES.filter((status) => status !== 'FINISHED').map((status) => ({
        ...match,
        status,
      })),
      { ...match, homeTeamId: null },
      { ...match, awayTeamId: null },
      { ...match, awayTeamId: match.homeTeamId },
      { ...match, homeGoals90: null },
      { ...match, awayGoals90: null },
    ];

    expect(selectTrainingMatches(ignored, before)).toEqual([]);
  });

  it('excludes later versions and invalid or inconsistent timestamps', () => {
    const later = new Date(before.getTime() + 1);
    const earlier = new Date(match.utcDate.getTime() - 1);
    const ignored: ModelMatch[] = [
      { ...match, utcDate: before, lastUpdated: later },
      { ...match, utcDate: later, lastUpdated: later },
      { ...match, lastUpdated: before },
      { ...match, lastUpdated: later },
      { ...match, lastUpdated: match.utcDate },
      { ...match, lastUpdated: earlier },
      { ...match, utcDate: new Date(NaN) },
      { ...match, lastUpdated: new Date(NaN) },
    ];

    expect(selectTrainingMatches([match, ...ignored], before)).toEqual([match]);
  });

  it('excludes negative, fractional and non-finite goal counts', () => {
    const ignored = [-1, 0.5, NaN, Infinity].flatMap((goals) => [
      { ...match, homeGoals90: goals },
      { ...match, awayGoals90: goals },
    ]);

    expect(selectTrainingMatches(ignored, before)).toEqual([]);
  });

  it('rejects an invalid cutoff', () => {
    expect(() => selectTrainingMatches([match], new Date(NaN))).toThrow(RangeError);
  });
});
