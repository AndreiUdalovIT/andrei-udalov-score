import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncCompetitionScorers } from './scorers';
import { runScorersCommand } from './scorers-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncCompetitionScorers: vi.fn<typeof syncCompetitionScorers>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./scorers', () => ({
  syncCompetitionScorers: mocks.syncCompetitionScorers,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncCompetitionScorers.mockReset().mockResolvedValue({
    competitionCode: 'PL',
    season: 2025,
    rowCount: 136,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scorers sync command', () => {
  it('loads the environment before syncing the requested competition and season', async () => {
    expect(
      await runScorersCommand(['--competition', ' pl ', '--season', '2025']),
    ).toBe(0);

    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionScorers).toHaveBeenCalledExactlyOnceWith('PL', {
      season: 2025,
    });
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncCompetitionScorers.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      'Synced 136 scorers for PL 2025.',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('shows help without loading the environment or running the sync', async () => {
    expect(await runScorersCommand(['--help'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: pnpm sync:scorers'),
    );
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
  });

  it('returns a failure exit code without exposing connection details', async () => {
    mocks.syncCompetitionScorers.mockRejectedValueOnce(
      new Error('Sensitive connection details'),
    );

    expect(await runScorersCommand(['--competition', 'PL'])).toBe(1);

    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Scorers sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
    );
    expect(console.log).not.toHaveBeenCalled();
  });
});
