import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/squad.json';
import { squadResponseSchema } from './squad';

// GET /v4/teams/57 and /v4/teams/851, captured on 2026-11-03.
// Each fixture keeps two players, including one unknown position or birth date.
function withPlayers(fields: Record<string, unknown>) {
  return {
    ...fixture.arsenal,
    squad: fixture.arsenal.squad.map((player) => ({ ...player, ...fields })),
  };
}

describe('squad response', () => {
  it.each(Object.entries(fixture))('parses the real %s response', (_name, data) => {
    const result = squadResponseSchema.parse(data);

    expect(result.id).toBe(data.id);
    expect(result.squad).toEqual(data.squad);
  });

  it('preserves unknown player details as null', () => {
    const result = squadResponseSchema.parse(
      withPlayers({ position: null, dateOfBirth: null, nationality: null }),
    );

    expect(result.squad[0]).toMatchObject({
      position: null,
      dateOfBirth: null,
      nationality: null,
    });
  });

  it('preserves a new upstream position without depending on an enum', () => {
    const result = squadResponseSchema.parse(withPlayers({ position: 'Wing-Back' }));

    expect(result.squad[0]?.position).toBe('Wing-Back');
  });

  it('accepts an empty squad', () => {
    const result = squadResponseSchema.parse({ ...fixture.arsenal, squad: [] });

    expect(result.squad).toEqual([]);
  });

  it('rejects a timestamp instead of a calendar birth date', () => {
    const result = squadResponseSchema.safeParse(
      withPlayers({ dateOfBirth: '1994-10-03T00:00:00Z' }),
    );

    expect(result.success).toBe(false);
  });

  it.each([null, undefined])(
    'rejects an unavailable squad %j instead of treating it as empty',
    (squad) => {
      expect(
        squadResponseSchema.safeParse({ ...fixture.arsenal, squad }).success,
      ).toBe(false);
    },
  );
});
