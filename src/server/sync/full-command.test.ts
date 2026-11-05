import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncFullCompetitions } from './full';
import { runFullCommand } from './full-command';
import type { runSync } from './run';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  runSync: vi.fn<typeof runSync>(),
  syncFullCompetitions: vi.fn<typeof syncFullCompetitions>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./run', () => ({ runSync: mocks.runSync }));
vi.mock('./full', () => ({
  syncFullCompetitions: mocks.syncFullCompetitions,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.runSync
    .mockReset()
    .mockImplementation(async (_mode, task) => task({ count: 0 }));
  mocks.syncFullCompetitions.mockReset().mockResolvedValue({
    competitions: [
      {
        competitionCode: 'PL',
        season: 2026,
        teamCount: 2,
        matchCount: 4,
        standingsCount: 2,
        scorerCount: 2,
      },
      {
        competitionCode: 'CL',
        season: 2025,
        teamCount: 2,
        matchCount: 4,
        standingsCount: 2,
        scorerCount: 2,
      },
    ],
    squadCount: 3,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('full sync command', () => {
  it('loads the environment before syncing all requested competitions', async () => {
    const exitCode = await runFullCommand([
      '--competition',
      ' pl ',
      '--competition',
      'CL',
    ]);

    expect(exitCode).toBe(0);
    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.runSync).toHaveBeenCalledExactlyOnceWith(
      'full',
      expect.any(Function),
    );
    expect(mocks.syncFullCompetitions).toHaveBeenCalledExactlyOnceWith(
      ['PL', 'CL'],
      { requestCounter: { count: 0 } },
    );
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runSync.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      'Synced PL 2026. 2 teams, 4 matches, 2 standings rows, 2 scorers.',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      'Synced CL 2025. 2 teams, 4 matches, 2 standings rows, 2 scorers.',
    );
    expect(console.log).toHaveBeenNthCalledWith(3, 'Synced 3 unique team squads.');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rejects an invalid later competition before loading the environment', async () => {
    const exitCode = await runFullCommand([
      '--competition',
      'PL',
      '--competition',
      '../CL',
    ]);

    expect(exitCode).toBe(2);
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.runSync).not.toHaveBeenCalled();
    expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid arguments.'),
    );
  });

  it('reports a failed full sync without printing success or error details', async () => {
    mocks.syncFullCompetitions.mockRejectedValueOnce(
      new Error('Sensitive connection details'),
    );

    expect(await runFullCommand(['--competition', 'PL'])).toBe(1);

    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Full sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
    expect(console.log).not.toHaveBeenCalled();
  });
});
