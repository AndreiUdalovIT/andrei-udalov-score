import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/matches.json';
import { matchSchema, matchesResponseSchema } from './matches';

// Trimmed from PL season 2026 and CL season 2025 responses on 2026-11-03.
describe('match schemas', () => {
  it('parses real match samples and preserves UTC strings', () => {
    const result = matchesResponseSchema.parse({
      matches: Object.values(fixture),
    });

    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]?.utcDate).toBe(fixture.upcoming.utcDate);
    expect(result.matches[0]?.lastUpdated).toBe(fixture.upcoming.lastUpdated);
  });

  it('preserves an unknown score without replacing it with zeros', () => {
    const result = matchSchema.parse(fixture.upcoming);

    expect(result.score.fullTime).toEqual({ home: null, away: null });
    expect(result.score.winner).toBeNull();
    expect(result.score).not.toHaveProperty('regularTime');
    expect(result.score).not.toHaveProperty('penalties');
  });

  it('keeps the 90-minute and extra-time scores separate', () => {
    const result = matchSchema.parse(fixture.extraTime);

    expect(result.score.duration).toBe('EXTRA_TIME');
    expect(result.score.fullTime).toEqual({ home: 3, away: 2 });
    expect(result.score.regularTime).toEqual({ home: 3, away: 0 });
    expect(result.score.extraTime).toEqual({ home: 0, away: 2 });
  });

  it('keeps shootout goals separate from the 90-minute score', () => {
    const result = matchSchema.parse(fixture.penalties);

    expect(result.matchday).toBeNull();
    expect(result.score.fullTime).toEqual({ home: 5, away: 4 });
    expect(result.score.regularTime).toEqual({ home: 1, away: 1 });
    expect(result.score.penalties).toEqual({ home: 4, away: 3 });
  });

  it('accepts an unknown participant without inventing an ID or a name', () => {
    const result = matchSchema.parse({
      ...fixture.upcoming,
      homeTeam: { id: null, name: null },
    });

    expect(result.homeTeam).toEqual({ id: null, name: null });
  });

  it('rejects an unknown status at the API boundary', () => {
    const result = matchSchema.safeParse({
      ...fixture.upcoming,
      status: 'FUTURE_STATUS',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['status']);
    }
  });

  it('rejects an unknown match duration', () => {
    const result = matchSchema.safeParse({
      ...fixture.upcoming,
      score: { ...fixture.upcoming.score, duration: 'FUTURE_DURATION' },
    });

    expect(result.success).toBe(false);
  });

  it.each([-1, 1.5, '0'])('rejects an invalid goal count %j', (home) => {
    const result = matchSchema.safeParse({
      ...fixture.upcoming,
      score: { ...fixture.upcoming.score, fullTime: { home, away: null } },
    });

    expect(result.success).toBe(false);
  });

  it.each(['not-a-date', '2026-11-06T20:00:00', '2026-02-30T20:00:00Z'])(
    'rejects an invalid UTC kickoff %s',
    (utcDate) => {
      const result = matchSchema.safeParse({ ...fixture.upcoming, utcDate });

      expect(result.success).toBe(false);
    },
  );

  it('distinguishes an unknown participant from a missing team object', () => {
    const result = matchSchema.safeParse({ ...fixture.upcoming, homeTeam: null });

    expect(result.success).toBe(false);
  });

  it('accepts an empty match list', () => {
    expect(matchesResponseSchema.parse({ matches: [] })).toEqual({ matches: [] });
  });

  it.each([null, {}, { matches: null }])(
    'rejects a malformed match list %j',
    (input) => {
      expect(matchesResponseSchema.safeParse(input).success).toBe(false);
    },
  );
});
