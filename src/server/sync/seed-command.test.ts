import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { runSync } from './run';
import type { syncSeedCompetitions } from './seed';
import { runSeedCommand } from './seed-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  runSync: vi.fn<typeof runSync>(),
  syncSeedCompetitions: vi.fn<typeof syncSeedCompetitions>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./run', () => ({ runSync: mocks.runSync }));
vi.mock('./seed', () => ({
  syncSeedCompetitions: mocks.syncSeedCompetitions,
}));

const requestCounter = { count: 4 };
const competition = {
  competitionCode: 'PL',
  season: 2026,
  teamCount: 20,
  matchCount: 380,
  standingsCount: 20,
  scorerCount: 136,
};
const result = {
  competitions: [competition],
  history: [{ ...competition, season: 2025 }],
  squadCount: 20,
  standingsHistory: [],
};

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.runSync
    .mockReset()
    .mockImplementation(async (_mode, _codes, task) => task(requestCounter));
  mocks.syncSeedCompetitions.mockReset().mockResolvedValue(result);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('seed sync command', () => {
  it('uses the service default and prints history and current results after finalization', async () => {
    const finalized = Promise.withResolvers<void>();
    const synced = Promise.withResolvers<void>();
    mocks.runSync.mockImplementationOnce(async (_mode, _codes, task) => {
      const result = await task(requestCounter);
      synced.resolve();
      await finalized.promise;
      return result;
    });

    const command = runSeedCommand(['--competition', ' pl ']);
    await synced.promise;

    expect(console.log).not.toHaveBeenCalled();
    expect(mocks.runSync).toHaveBeenCalledExactlyOnceWith(
      'seed',
      ['PL'],
      expect.any(Function),
    );
    expect(mocks.syncSeedCompetitions).toHaveBeenCalledExactlyOnceWith(['PL'], {
      historySeasons: undefined,
      includeStandingsHistory: false,
      requestCounter,
    });
    expect(mocks.syncSeedCompetitions.mock.calls[0]?.[1]?.requestCounter).toBe(
      requestCounter,
    );
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runSync.mock.invocationCallOrder[0]!,
    );
    finalized.resolve();

    expect(await command).toBe(0);
    expect(console.log).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      'Synced PL 2025. 20 teams, 380 matches, 20 standings rows, 136 scorers.',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      'Synced PL 2026. 20 teams, 380 matches, 20 standings rows, 136 scorers.',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      3,
      'Synced 20 unique current team squads.',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'forwards an explicit history depth of %s',
    async (historySeasons) => {
      mocks.syncSeedCompetitions.mockResolvedValueOnce({ ...result, history: [] });

      expect(
        await runSeedCommand([
          '--competition',
          'PL',
          '--history-seasons',
          String(historySeasons),
        ]),
      ).toBe(0);

      expect(mocks.syncSeedCompetitions).toHaveBeenCalledExactlyOnceWith(['PL'], {
        historySeasons,
        includeStandingsHistory: false,
        requestCounter,
      });
    },
  );

  it('enables standings history and prints the snapshot count', async () => {
    mocks.syncSeedCompetitions.mockResolvedValueOnce({
      ...result,
      standingsHistory: [
        {
          competitionCode: 'PL',
          season: 2025,
          snapshots: [{ matchday: 1, rowCount: 20 }],
        },
      ],
    });

    expect(
      await runSeedCommand(['--competition', 'PL', '--standings-history']),
    ).toBe(0);

    expect(mocks.syncSeedCompetitions).toHaveBeenCalledExactlyOnceWith(['PL'], {
      historySeasons: undefined,
      includeStandingsHistory: true,
      requestCounter,
    });
    expect(console.log).toHaveBeenCalledWith(
      'Captured 1 reconstructed standings snapshots for PL 2025.',
    );
  });

  it.each(['-1', '1e3', '9007199254740992'])(
    'rejects invalid history depth %s before starting a run',
    async (historyValue) => {
      expect(
        await runSeedCommand([
          '--competition',
          'PL',
          '--history-seasons',
          historyValue,
        ]),
      ).toBe(2);

      expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
      expect(mocks.runSync).not.toHaveBeenCalled();
      expect(mocks.syncSeedCompetitions).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid arguments.'),
      );
    },
  );
});
