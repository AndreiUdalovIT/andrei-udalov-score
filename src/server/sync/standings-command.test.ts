import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncCompetitionStandings } from './standings';
import { runStandingsCommand } from './standings-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncCompetitionStandings: vi.fn<typeof syncCompetitionStandings>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./standings', () => ({
  syncCompetitionStandings: mocks.syncCompetitionStandings,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncCompetitionStandings.mockReset().mockResolvedValue({
    competitionCode: 'PL',
    season: 2026,
    rowCount: 20,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standings sync command', () => {
  it.each([
    { args: ['--competition', ' pl '], season: undefined },
    { args: ['--competition', 'PL', '--season', '2025'], season: 2025 },
  ])('passes the requested season $season to the sync', async ({ args, season }) => {
    mocks.syncCompetitionStandings.mockResolvedValue({
      competitionCode: 'PL',
      season: season ?? 2026,
      rowCount: 20,
    });

    expect(await runStandingsCommand(args)).toBe(0);

    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionStandings).toHaveBeenCalledExactlyOnceWith('PL', {
      season,
    });
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncCompetitionStandings.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledWith(
      `Synced 20 standings rows for PL ${season ?? 2026}.`,
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports a valid empty snapshot as a successful sync', async () => {
    mocks.syncCompetitionStandings.mockResolvedValue({
      competitionCode: 'PL',
      season: 2026,
      rowCount: 0,
    });

    expect(await runStandingsCommand(['--competition', 'PL'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith('Synced 0 standings rows for PL 2026.');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('shows help without loading environment variables or running the sync', async () => {
    expect(await runStandingsCommand(['--help'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
  });

  it.each([{ args: [] }, { args: ['--competition', 'PL', '--season', '2025oops'] }])(
    'rejects invalid arguments $args before loading the environment',
    async ({ args }) => {
      expect(await runStandingsCommand(args)).toBe(2);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid arguments.'),
      );
      expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
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
        mocks.syncCompetitionStandings.mockRejectedValueOnce(error);
      }

      expect(await runStandingsCommand(['--competition', 'PL'])).toBe(1);

      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        'Standings sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
      );
      expect(console.log).not.toHaveBeenCalled();
      if (stage === 'environment') {
        expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
      }
    },
  );
});
