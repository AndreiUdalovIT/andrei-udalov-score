import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncLightCompetitions } from './light';
import { runLightCommand } from './light-command';
import type { runSync } from './run';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  runSync: vi.fn<typeof runSync>(),
  syncLightCompetitions: vi.fn<typeof syncLightCompetitions>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./run', () => ({ runSync: mocks.runSync }));
vi.mock('./light', () => ({
  syncLightCompetitions: mocks.syncLightCompetitions,
}));

const requestCounter = { count: 4 };

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.runSync
    .mockReset()
    .mockImplementation(async (_mode, _codes, task) => task(requestCounter));
  mocks.syncLightCompetitions.mockReset().mockResolvedValue({
    dateFrom: '2026-10-30',
    dateTo: '2026-11-13',
    competitions: [
      {
        competitionCode: 'PL',
        season: 2026,
        teamCount: 20,
        matchCount: 20,
        standingsCount: 20,
        scorerCount: 136,
      },
    ],
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('light sync command', () => {
  it('shares the journal counter and prints the window only after finalization', async () => {
    const finalized = Promise.withResolvers<void>();
    const synced = Promise.withResolvers<void>();
    mocks.runSync.mockImplementationOnce(async (_mode, _codes, task) => {
      const result = await task(requestCounter);
      synced.resolve();
      await finalized.promise;
      return result;
    });

    const command = runLightCommand(['--competition', ' pl ']);
    await synced.promise;

    expect(console.log).not.toHaveBeenCalled();
    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.runSync).toHaveBeenCalledExactlyOnceWith(
      'light',
      ['PL'],
      expect.any(Function),
    );
    expect(mocks.syncLightCompetitions).toHaveBeenCalledExactlyOnceWith(['PL'], {
      requestCounter,
    });
    expect(mocks.syncLightCompetitions.mock.calls[0]?.[1]?.requestCounter).toBe(
      requestCounter,
    );
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runSync.mock.invocationCallOrder[0]!,
    );
    finalized.resolve();

    expect(await command).toBe(0);
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      'Synced PL 2026. 20 teams, 20 matches, 20 standings rows, 136 scorers.',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      'Match window: 2026-10-30 to 2026-11-13 (UTC, inclusive).',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports a journal failure after syncing without printing success or details', async () => {
    mocks.runSync.mockImplementationOnce(async (_mode, _codes, task) => {
      await task(requestCounter);
      throw new Error('Sensitive connection details');
    });

    expect(await runLightCommand(['--competition', 'PL'])).toBe(1);

    expect(mocks.syncLightCompetitions).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Light sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
  });

  it('rejects a historical season before loading the environment or starting a run', async () => {
    const exitCode = await runLightCommand([
      '--competition',
      'PL',
      '--season',
      '2025',
    ]);

    expect(exitCode).toBe(2);
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.runSync).not.toHaveBeenCalled();
    expect(mocks.syncLightCompetitions).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid arguments.'),
    );
  });
});
