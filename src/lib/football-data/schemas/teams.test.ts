import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/competition-teams.json';
import { teamsResponseSchema } from './teams';

// GET /v4/competitions/PL/teams, captured on 2026-11-03.
// The fixture keeps one team and the competition/season fields.
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
});
