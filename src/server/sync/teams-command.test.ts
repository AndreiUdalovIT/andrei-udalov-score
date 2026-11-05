import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncCompetitionTeams } from './teams';
import { runTeamsCommand } from './teams-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncCompetitionTeams: vi.fn<typeof syncCompetitionTeams>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./teams', () => ({
  syncCompetitionTeams: mocks.syncCompetitionTeams,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncCompetitionTeams.mockReset().mockResolvedValue({
    competitionCode: 'PL',
    season: 2026,
    teamCount: 20,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('teams sync command', () => {
  it.each([
    { args: ['--competition', ' pl '], season: undefined },
    { args: ['--competition', 'PL', '--season', '2025'], season: 2025 },
  ])('passes the requested season $season to the sync', async ({ args, season }) => {
    mocks.syncCompetitionTeams.mockResolvedValue({
      competitionCode: 'PL',
      season: season ?? 2026,
      teamCount: 20,
    });

    expect(await runTeamsCommand(args)).toBe(0);

    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionTeams).toHaveBeenCalledWith('PL', { season });
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncCompetitionTeams.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledWith(
      `Synced 20 teams for PL ${season ?? 2026}.`,
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('shows help without loading environment variables or running the sync', async () => {
    expect(await runTeamsCommand(['--help'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
  });

  it.each([
    { args: [] },
    { args: ['--competition', '../PL'] },
    { args: ['--competition', 'PL', '--season', '2025oops'] },
    { args: ['--competition', 'PL', '--unknown'] },
  ])(
    'rejects invalid arguments $args before loading the environment',
    async ({ args }) => {
      expect(await runTeamsCommand(args)).toBe(2);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid arguments.'),
      );
      expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
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
        mocks.syncCompetitionTeams.mockRejectedValueOnce(error);
      }

      expect(await runTeamsCommand(['--competition', 'PL'])).toBe(1);

      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        'Team sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
      );
      expect(console.log).not.toHaveBeenCalled();
      if (stage === 'environment') {
        expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
      }
    },
  );
});
