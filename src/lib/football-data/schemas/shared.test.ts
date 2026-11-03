import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/competition-teams.json';
import { competitionSchema, idSchema, seasonSchema, teamSchema } from './shared';

describe('shared football-data schemas', () => {
  it('accepts a positive integer ID', () => {
    expect(idSchema.parse(57)).toBe(57);
  });

  it.each([null, '57', 0, -1, 1.5])('rejects an invalid resource ID %j', (id) => {
    expect(idSchema.safeParse(id).success).toBe(false);
  });

  it('preserves an unknown competition emblem', () => {
    const result = competitionSchema.parse({
      ...fixture.competition,
      emblem: null,
    });

    expect(result.emblem).toBeNull();
  });

  it('keeps calendar season dates and an unknown matchday', () => {
    const result = seasonSchema.parse({
      ...fixture.season,
      currentMatchday: null,
    });

    expect(result).toMatchObject({
      startDate: '2026-08-21',
      endDate: '2027-05-30',
      currentMatchday: null,
    });
  });

  it.each(['2026-02-30', 'not-a-date', '2026-08-21T00:00:00Z'])(
    'rejects an invalid season date %s',
    (startDate) => {
      expect(seasonSchema.safeParse({ ...fixture.season, startDate }).success).toBe(
        false,
      );
    },
  );

  it('parses a real team', () => {
    expect(teamSchema.parse(fixture.teams[0])).toEqual(fixture.teams[0]);
  });

  it('preserves unknown team details without inventing values', () => {
    const unknownDetails = {
      shortName: null,
      tla: null,
      crest: null,
      clubColors: null,
    };
    const result = teamSchema.parse({ ...fixture.teams[0], ...unknownDetails });

    expect(result).toMatchObject(unknownDetails);
  });

  it.each(['', null, undefined])('rejects a missing team name %j', (name) => {
    expect(teamSchema.safeParse({ ...fixture.teams[0], name }).success).toBe(false);
  });

  it('distinguishes a missing nullable field from an explicit null', () => {
    const result = teamSchema.safeParse({
      ...fixture.teams[0],
      shortName: undefined,
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid crest URL', () => {
    const result = teamSchema.safeParse({
      ...fixture.teams[0],
      crest: 'not-a-url',
    });

    expect(result.success).toBe(false);
  });
});
