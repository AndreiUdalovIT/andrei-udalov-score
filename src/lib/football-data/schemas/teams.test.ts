import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/competition-teams.json';
import { teamsResponseSchema } from './teams';

// GET /v4/competitions/PL/teams, captured on 2026-11-03.
// The fixture keeps one team and the competition/season fields.
function withTeam(fields: Record<string, unknown>) {
  return {
    ...fixture,
    teams: fixture.teams.map((team) => ({ ...team, ...fields })),
  };
}

describe('competition teams response', () => {
  it('parses a trimmed real response and keeps dates as calendar strings', () => {
    const result = teamsResponseSchema.parse(fixture);

    expect(result.competition.code).toBe('PL');
    expect(result.season.startDate).toBe('2026-08-21');
    expect(result.season.endDate).toBe('2027-05-30');
    expect(result.teams).toEqual(fixture.teams);
  });

  it('accepts additional API fields without adding them to the parsed result', () => {
    const result = teamsResponseSchema.parse({
      ...fixture,
      filters: { season: '2026' },
      teams: fixture.teams.map((team) => ({ ...team, venue: 'Emirates Stadium' })),
    });

    expect(result).not.toHaveProperty('filters');
    expect(result.competition).not.toHaveProperty('type');
    expect(result.season).not.toHaveProperty('winner');
    expect(result.teams[0]).not.toHaveProperty('venue');
  });

  it.each(['shortName', 'tla', 'crest', 'clubColors'] as const)(
    'preserves a null %s without inventing a value',
    (field) => {
      const result = teamsResponseSchema.parse(withTeam({ [field]: null }));

      expect(result.teams[0]?.[field]).toBeNull();
    },
  );

  it('preserves an unknown matchday and competition emblem', () => {
    const result = teamsResponseSchema.parse({
      ...fixture,
      competition: { ...fixture.competition, emblem: null },
      season: { ...fixture.season, currentMatchday: null },
    });

    expect(result.season.currentMatchday).toBeNull();
    expect(result.competition.emblem).toBeNull();
  });

  it('accepts an empty list of teams', () => {
    const result = teamsResponseSchema.parse({ ...fixture, teams: [] });

    expect(result.teams).toEqual([]);
  });

  it.each([null, {}, { ...fixture, teams: null }, { ...fixture, teams: undefined }])(
    'rejects a malformed response instead of treating it as an empty list: %j',
    (input) => {
      expect(teamsResponseSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([null, '57', 0, -1, 1.5])('rejects an invalid team ID %j', (id) => {
    expect(teamsResponseSchema.safeParse(withTeam({ id })).success).toBe(false);
  });

  it.each(['', null, undefined])('rejects a missing team name %j', (name) => {
    expect(teamsResponseSchema.safeParse(withTeam({ name })).success).toBe(false);
  });

  it('distinguishes a missing nullable field from an explicit null', () => {
    const result = teamsResponseSchema.safeParse(withTeam({ shortName: undefined }));

    expect(result.success).toBe(false);
  });

  it.each(['2026-02-30', 'not-a-date', '2026-08-21T00:00:00Z'])(
    'rejects an invalid season date %s',
    (startDate) => {
      const result = teamsResponseSchema.safeParse({
        ...fixture,
        season: { ...fixture.season, startDate },
      });

      expect(result.success).toBe(false);
    },
  );

  it('rejects an invalid crest URL', () => {
    const result = teamsResponseSchema.safeParse(withTeam({ crest: 'not-a-url' }));

    expect(result.success).toBe(false);
  });
});
