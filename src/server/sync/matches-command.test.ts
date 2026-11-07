import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncCompetitionMatches } from './matches';
import { runMatchesCommand } from './matches-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncCompetitionMatches: vi.fn<typeof syncCompetitionMatches>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./matches', () => ({
  syncCompetitionMatches: mocks.syncCompetitionMatches,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncCompetitionMatches.mockReset().mockResolvedValue({
    competitionCode: 'PL',
    matchCount: 10,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('matches sync command', () => {
  it.each([
    {
      label: 'the current season',
      args: ['--competition', ' pl '],
      filters: {},
    },
    {
      label: 'a historical season with a same-day window and status',
      args: [
        '--competition',
        'PL',
        '--season',
        '2025',
        '--date-from',
        '2025-11-06',
        '--date-to',
        '2025-11-06',
        '--status',
        'finished',
      ],
      filters: {
        season: 2025,
        status: 'FINISHED',
        dateFrom: '2025-11-06',
        dateTo: '2025-11-06',
      },
    },
  ])(
    'passes $label to the sync after loading the environment',
    async ({ args, filters }) => {
      expect(await runMatchesCommand(args)).toBe(0);

      expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
      expect(mocks.syncCompetitionMatches).toHaveBeenCalledExactlyOnceWith('PL', {
        season: undefined,
        status: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        ...filters,
      });
      expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.syncCompetitionMatches.mock.invocationCallOrder[0]!,
      );
      expect(console.log).toHaveBeenCalledWith('Processed 10 matches for PL.');
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it('shows help without loading environment variables or running the sync', async () => {
    expect(await runMatchesCommand(['--help'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--competition', 'PL', '--date-from', '2026-11-01'] },
    {
      args: [
        '--competition',
        'PL',
        '--date-from',
        '2026-02-30',
        '--date-to',
        '2026-03-01',
      ],
    },
    {
      args: [
        '--competition',
        'PL',
        '--date-from',
        '2026-11-07',
        '--date-to',
        '2026-11-01',
      ],
    },
    { args: ['--competition', 'PL', '--status', 'PENDING'] },
  ])(
    'rejects invalid arguments $args before loading the environment',
    async ({ args }) => {
      expect(await runMatchesCommand(args)).toBe(2);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid arguments.'),
      );
      expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
    },
  );

  it.each(['environment', 'sync'])(
    'reports a failed %s without exposing its details',
    async (stage) => {
      const error = new Error('Sensitive connection details');
      if (stage === 'environment') {
        mocks.loadEnvConfig.mockImplementationOnce(() => {
          throw error;
        });
      } else {
        mocks.syncCompetitionMatches.mockRejectedValueOnce(error);
      }

      expect(await runMatchesCommand(['--competition', 'PL'])).toBe(1);

      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        'Match sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
      );
      expect(console.log).not.toHaveBeenCalled();
      if (stage === 'environment') {
        expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
      }
    },
  );
});
