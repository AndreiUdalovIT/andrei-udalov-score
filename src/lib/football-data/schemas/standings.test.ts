import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/standings.json';
import { standingsResponseSchema } from './standings';

// PL and CL standings captured on 2026-11-03; only the first and last rows remain.
function withRows(fields: Record<string, unknown>) {
  return {
    ...fixture.league,
    standings: fixture.league.standings.map((standing) => ({
      ...standing,
      table: standing.table.map((row) => ({ ...row, ...fields })),
    })),
  };
}

describe('standings response', () => {
  it.each(Object.entries(fixture))(
    'parses the real %s response without renumbering rows',
    (_name, data) => {
      const result = standingsResponseSchema.parse(data);

      expect(result.competition.code).toBe(data.competition.code);
      expect(result.standings[0]?.stage).toBe(data.standings[0]?.stage);
      expect(result.standings[0]?.group).toBe(data.standings[0]?.group);
      expect(result.standings[0]?.table.map((row) => row.position)).toEqual(
        data.standings[0]?.table.map((row) => row.position),
      );
      expect(result.standings[0]?.table[1]?.goalDifference).toBeLessThan(0);
    },
  );

  it('preserves negative official points instead of recalculating them', () => {
    const result = standingsResponseSchema.parse(withRows({ points: -3 }));

    expect(result.standings[0]?.table[0]?.points).toBe(-3);
  });

  it('keeps TOTAL, HOME and AWAY tables separate', () => {
    const result = standingsResponseSchema.parse({
      ...fixture.league,
      standings: fixture.league.standings.flatMap((standing) => [
        standing,
        { ...standing, type: 'HOME' },
        { ...standing, type: 'AWAY' },
      ]),
    });

    expect(result.standings.map((standing) => standing.type)).toEqual([
      'TOTAL',
      'HOME',
      'AWAY',
    ]);
  });

  it('accepts an ungrouped empty table', () => {
    const result = standingsResponseSchema.parse({
      ...fixture.league,
      standings: fixture.league.standings.map((standing) => ({
        ...standing,
        group: null,
        table: [],
      })),
    });

    expect(result.standings[0]).toMatchObject({ group: null, table: [] });
  });

  it('accepts an empty standings list', () => {
    const result = standingsResponseSchema.parse({
      ...fixture.league,
      standings: [],
    });

    expect(result.standings).toEqual([]);
  });

  it('rejects an unknown table type', () => {
    const result = standingsResponseSchema.safeParse({
      ...fixture.league,
      standings: fixture.league.standings.map((standing) => ({
        ...standing,
        type: 'FUTURE_TABLE',
      })),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['standings', 0, 'type']);
    }
  });

  it.each([0, 1.5, '1'])('rejects an invalid position %j', (position) => {
    expect(standingsResponseSchema.safeParse(withRows({ position })).success).toBe(
      false,
    );
  });

  it.each([-1, 1.5, '9', null])(
    'rejects an invalid played-games count %j',
    (playedGames) => {
      expect(
        standingsResponseSchema.safeParse(withRows({ playedGames })).success,
      ).toBe(false);
    },
  );

  it('rejects unknown points instead of replacing them with zero', () => {
    expect(
      standingsResponseSchema.safeParse(withRows({ points: null })).success,
    ).toBe(false);
  });

  it('rejects a ranked row without a known team ID', () => {
    const result = standingsResponseSchema.safeParse(
      withRows({
        team: { id: null, name: 'Unknown', shortName: null, tla: null, crest: null },
      }),
    );

    expect(result.success).toBe(false);
  });

  it.each([null, {}, { ...fixture.league, standings: null }])(
    'rejects a malformed response %j',
    (input) => {
      expect(standingsResponseSchema.safeParse(input).success).toBe(false);
    },
  );
});
