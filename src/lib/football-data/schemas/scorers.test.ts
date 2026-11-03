import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/scorers.json';
import { scorersResponseSchema } from './scorers';

// PL and CL scorers captured on 2026-11-03; only two entries per response remain.
function withScorers(fields: Record<string, unknown>) {
  return {
    ...fixture.league,
    scorers: fixture.league.scorers.map((scorer) => ({ ...scorer, ...fields })),
  };
}

describe('scorers response', () => {
  it.each(Object.entries(fixture))('parses the real %s response', (_name, data) => {
    const result = scorersResponseSchema.parse(data);

    expect(result.competition.code).toBe(data.competition.code);
    expect(result.scorers).toEqual(data.scorers);
  });

  it('preserves unknown assists and penalties', () => {
    const result = scorersResponseSchema.parse(fixture.league);

    expect(result.scorers[0]?.assists).toBeNull();
    expect(result.scorers[0]?.penalties).toBeNull();
  });

  it('preserves known zeroes without turning them into null', () => {
    const result = scorersResponseSchema.parse(
      withScorers({
        assists: 0,
        penalties: 0,
      }),
    );

    expect(result.scorers[0]?.assists).toBe(0);
    expect(result.scorers[0]?.penalties).toBe(0);
  });

  it('preserves a known penalty count', () => {
    const result = scorersResponseSchema.parse(fixture.championsLeague);

    expect(result.scorers[0]?.penalties).toBe(2);
  });

  it('accepts an empty scorer list', () => {
    const result = scorersResponseSchema.parse({ ...fixture.league, scorers: [] });

    expect(result.scorers).toEqual([]);
  });

  it.each(['playedMatches', 'goals'] as const)(
    'rejects an unknown required %s instead of inventing a count',
    (field) => {
      expect(
        scorersResponseSchema.safeParse(withScorers({ [field]: null })).success,
      ).toBe(false);
    },
  );

  it.each(['assists', 'penalties'] as const)(
    'distinguishes an omitted %s from an explicit null',
    (field) => {
      expect(
        scorersResponseSchema.safeParse(withScorers({ [field]: undefined })).success,
      ).toBe(false);
    },
  );

  it.each([
    { goals: -1 },
    { playedMatches: 1.5 },
    { assists: '0' },
    { penalties: -1 },
  ])('rejects an invalid statistic %j', (fields) => {
    expect(scorersResponseSchema.safeParse(withScorers(fields)).success).toBe(false);
  });

  it('rejects a scorer without a known player ID', () => {
    const result = scorersResponseSchema.safeParse(
      withScorers({ player: { id: null, name: 'Unknown' } }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects a scorer without a known team ID', () => {
    const result = scorersResponseSchema.safeParse(
      withScorers({
        team: { id: null, name: 'Unknown', shortName: null, tla: null, crest: null },
      }),
    );

    expect(result.success).toBe(false);
  });

  it.each([null, {}, { ...fixture.league, scorers: null }])(
    'rejects a malformed response %j',
    (input) => {
      expect(scorersResponseSchema.safeParse(input).success).toBe(false);
    },
  );
});
