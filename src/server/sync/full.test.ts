import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncFullCompetitions } from './full';
import type { syncCompetitionMatches } from './matches';
import type { syncCompetitionScorers } from './scorers';
import type { syncTeamSquad } from './squad';
import type { syncCompetitionStandings } from './standings';
import type { syncCompetitionTeams } from './teams';

const mocks = vi.hoisted(() => ({
  syncCompetitionTeams: vi.fn<typeof syncCompetitionTeams>(),
  syncCompetitionMatches: vi.fn<typeof syncCompetitionMatches>(),
  syncCompetitionStandings: vi.fn<typeof syncCompetitionStandings>(),
  syncCompetitionScorers: vi.fn<typeof syncCompetitionScorers>(),
  syncTeamSquad: vi.fn<typeof syncTeamSquad>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./teams', () => ({
  syncCompetitionTeams: mocks.syncCompetitionTeams,
}));
vi.mock('./matches', () => ({
  syncCompetitionMatches: mocks.syncCompetitionMatches,
}));
vi.mock('./standings', () => ({
  syncCompetitionStandings: mocks.syncCompetitionStandings,
}));
vi.mock('./scorers', () => ({
  syncCompetitionScorers: mocks.syncCompetitionScorers,
}));
vi.mock('./squad', () => ({ syncTeamSquad: mocks.syncTeamSquad }));

const premierLeague = {
  competitionCode: 'PL',
  season: 2026,
  teamCount: 2,
  teamIds: [57, 65],
};

beforeEach(() => {
  mocks.syncCompetitionTeams.mockReset().mockResolvedValue(premierLeague);
  mocks.syncCompetitionMatches
    .mockReset()
    .mockImplementation(async (competitionCode) => ({
      competitionCode,
      matchCount: 4,
    }));
  mocks.syncCompetitionStandings
    .mockReset()
    .mockImplementation(async (competitionCode, { season } = {}) => ({
      competitionCode,
      season: season ?? 2026,
      rowCount: 2,
    }));
  mocks.syncCompetitionScorers
    .mockReset()
    .mockImplementation(async (competitionCode, { season } = {}) => ({
      competitionCode,
      season: season ?? 2026,
      rowCount: 2,
    }));
  mocks.syncTeamSquad.mockReset().mockImplementation(async (teamId) => ({
    teamId,
    playerCount: 1,
  }));
});

describe('full competition sync', () => {
  it('pins each season and syncs shared clubs once after loading teams', async () => {
    const pending = Promise.withResolvers<typeof premierLeague>();
    mocks.syncCompetitionTeams
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        competitionCode: 'CL',
        season: 2025,
        teamCount: 2,
        teamIds: [57, 851],
      });
    const signal = new AbortController().signal;

    const result = syncFullCompetitions([' pl ', 'CL', 'PL'], { signal });
    expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
    expect(mocks.syncTeamSquad).not.toHaveBeenCalled();
    pending.resolve(premierLeague);

    await expect(result).resolves.toEqual({
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
    expect(mocks.syncCompetitionTeams).toHaveBeenCalledTimes(2);
    expect(mocks.syncCompetitionTeams).toHaveBeenNthCalledWith(1, 'PL', { signal });
    expect(mocks.syncCompetitionTeams).toHaveBeenNthCalledWith(2, 'CL', { signal });
    for (const syncDataset of [
      mocks.syncCompetitionMatches,
      mocks.syncCompetitionStandings,
      mocks.syncCompetitionScorers,
    ]) {
      expect(syncDataset).toHaveBeenCalledTimes(2);
      expect(syncDataset).toHaveBeenCalledWith('PL', { season: 2026, signal });
      expect(syncDataset).toHaveBeenCalledWith('CL', { season: 2025, signal });
    }
    expect(mocks.syncTeamSquad).toHaveBeenCalledTimes(3);
    for (const teamId of [57, 65, 851]) {
      expect(mocks.syncTeamSquad).toHaveBeenCalledWith(teamId, { signal });
    }
  });

  it('stops the run when a required dataset fails', async () => {
    const error = new Error('API unavailable');
    mocks.syncCompetitionMatches.mockRejectedValueOnce(error);

    await expect(syncFullCompetitions(['PL', 'CL'])).rejects.toBe(error);

    expect(mocks.syncCompetitionTeams).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
    expect(mocks.syncTeamSquad).not.toHaveBeenCalled();
  });

  it.each([{ codes: [] }, { codes: ['PL', '../CL'] }])(
    'rejects invalid competition lists $codes before starting the sync',
    async ({ codes }) => {
      await expect(syncFullCompetitions(codes)).rejects.toThrow();

      expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
      expect(mocks.syncTeamSquad).not.toHaveBeenCalled();
    },
  );
});
