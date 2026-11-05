import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncTeamSquad } from './squad';
import { runSquadCommand } from './squad-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncTeamSquad: vi.fn<typeof syncTeamSquad>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./squad', () => ({ syncTeamSquad: mocks.syncTeamSquad }));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncTeamSquad.mockReset().mockResolvedValue({
    teamId: 851,
    playerCount: 2,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('squad sync command', () => {
  it('syncs the requested numeric team ID after loading the environment', async () => {
    expect(await runSquadCommand(['--team', ' 851 '])).toBe(0);

    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.syncTeamSquad).toHaveBeenCalledExactlyOnceWith(851);
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncTeamSquad.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      'Synced 2 squad players for team 851.',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['57oops', '9007199254740992'])(
    'rejects invalid team ID %s before loading the environment',
    async (value) => {
      expect(await runSquadCommand(['--team', value])).toBe(2);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid arguments.'),
      );
      expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
      expect(mocks.syncTeamSquad).not.toHaveBeenCalled();
    },
  );
});
