import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncLightCompetitions } from './light';
import type { syncCompetitionMatches } from './matches';
import type { syncCompetitionScorers } from './scorers';
import type { syncCompetitionStandings } from './standings';
import type { syncCompetitionTeams } from './teams';

const mocks = vi.hoisted(() => ({
  syncCompetitionTeams: vi.fn<typeof syncCompetitionTeams>(),
  syncCompetitionMatches: vi.fn<typeof syncCompetitionMatches>(),
  syncCompetitionStandings: vi.fn<typeof syncCompetitionStandings>(),
  syncCompetitionScorers: vi.fn<typeof syncCompetitionScorers>(),
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

const premierLeague = {
  competitionCode: 'PL',
  season: 2026,
  teamCount: 2,
  teamIds: [57, 65],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:30:00+09:00'));
  mocks.syncCompetitionTeams.mockReset().mockResolvedValue(premierLeague);
  mocks.syncCompetitionMatches
    .mockReset()
    .mockImplementation(async (competitionCode) => ({
      competitionCode,
      matchCount: 0,
    }));
  for (const syncDataset of [
    mocks.syncCompetitionStandings,
    mocks.syncCompetitionScorers,
  ]) {
    syncDataset
      .mockReset()
      .mockImplementation(async (competitionCode, { season } = {}) => ({
        competitionCode,
        season: season ?? 2026,
        rowCount: 2,
      }));
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('light competition sync', () => {
  it('uses one UTC window and each current season after loading teams', async () => {
    const pending = Promise.withResolvers<typeof premierLeague>();
    mocks.syncCompetitionTeams
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        competitionCode: 'CL',
        season: 2025,
        teamCount: 2,
        teamIds: [57, 851],
      });
    const options = {
      signal: new AbortController().signal,
      requestCounter: { count: 0 },
    };

    const result = syncLightCompetitions([' pl ', 'CL', 'PL'], options);
    expect(mocks.syncCompetitionMatches).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2027-01-01T18:00:00Z'));
    pending.resolve(premierLeague);

    await expect(result).resolves.toEqual({
      dateFrom: '2026-12-24',
      dateTo: '2027-01-07',
      competitions: [
        {
          competitionCode: 'PL',
          season: 2026,
          teamCount: 2,
          matchCount: 0,
          standingsCount: 2,
          scorerCount: 2,
        },
        {
          competitionCode: 'CL',
          season: 2025,
          teamCount: 2,
          matchCount: 0,
          standingsCount: 2,
          scorerCount: 2,
        },
      ],
    });
    expect(mocks.syncCompetitionTeams).toHaveBeenCalledTimes(2);
    expect(mocks.syncCompetitionTeams).toHaveBeenNthCalledWith(1, 'PL', options);
    expect(mocks.syncCompetitionTeams).toHaveBeenNthCalledWith(2, 'CL', options);
    expect(mocks.syncCompetitionMatches).toHaveBeenCalledTimes(2);
    expect(mocks.syncCompetitionStandings).toHaveBeenCalledTimes(2);
    expect(mocks.syncCompetitionScorers).toHaveBeenCalledTimes(2);
    for (const [code, season] of [
      ['PL', 2026],
      ['CL', 2025],
    ] as const) {
      expect(mocks.syncCompetitionMatches).toHaveBeenCalledWith(code, {
        season,
        ...options,
        dateFrom: '2026-12-24',
        dateTo: '2027-01-07',
      });
      expect(mocks.syncCompetitionStandings).toHaveBeenCalledWith(code, {
        season,
        ...options,
        captureOfficial: true,
      });
      expect(mocks.syncCompetitionScorers).toHaveBeenCalledWith(code, {
        season,
        ...options,
      });
    }
  });

  it.each([
    {
      now: '2028-03-01T00:30:00Z',
      dateFrom: '2028-02-23',
      dateTo: '2028-03-08',
    },
    {
      now: '2027-03-14T00:30:00-05:00',
      dateFrom: '2027-03-07',
      dateTo: '2027-03-21',
    },
  ])('keeps calendar bounds across $now', async ({ now, dateFrom, dateTo }) => {
    vi.setSystemTime(new Date(now));

    const result = await syncLightCompetitions(['PL']);

    expect(result).toMatchObject({ dateFrom, dateTo });
    expect(mocks.syncCompetitionMatches).toHaveBeenCalledWith(
      'PL',
      expect.objectContaining({ dateFrom, dateTo }),
    );
  });

  it('stops before the next competition when a required dataset fails', async () => {
    const error = new Error('API unavailable');
    mocks.syncCompetitionStandings.mockRejectedValueOnce(error);

    await expect(syncLightCompetitions(['PL', 'CL'])).rejects.toBe(error);

    expect(mocks.syncCompetitionTeams).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionMatches).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
  });
});
