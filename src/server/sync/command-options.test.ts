import { describe, expect, it, vi } from 'vitest';

import { parseCompetitionOptions } from './command-options';

vi.mock('server-only', () => ({}));

describe('competition sync options', () => {
  it.each([
    { values: { competition: ' pl ' }, season: undefined },
    { values: { competition: 'PL', season: '2025' }, season: 2025 },
  ])('parses the requested season $season', ({ values, season }) => {
    expect(parseCompetitionOptions(values)).toEqual({
      competitionCode: 'PL',
      season,
    });
  });

  it.each([{}, { competition: '../PL' }, { competition: 'PL', season: '2025oops' }])(
    'rejects invalid competition options %j',
    (values) => {
      expect(() => parseCompetitionOptions(values)).toThrow(
        'Invalid competition sync options',
      );
    },
  );
});
