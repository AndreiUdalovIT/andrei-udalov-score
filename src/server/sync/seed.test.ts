import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createFootballDataApi } from '@/lib/football-data/api';
import { FootballDataHttpError } from '@/lib/football-data/client';

import type { syncFullCompetitions } from './full';
import type { syncCompetitionMatches } from './matches';
import type { syncCompetitionScorers } from './scorers';
import { syncSeedCompetitions } from './seed';
import type { syncCompetitionStandings } from './standings';
import {
  historyCompetitionCodes,
  type syncCompetitionStandingsHistory,
} from './standings-history';
import type { syncCompetitionTeams } from './teams';

const mocks = vi.hoisted(() => ({
  getCompetition:
    vi.fn<ReturnType<typeof createFootballDataApi>['getCompetition']>(),
  syncFullCompetitions: vi.fn<typeof syncFullCompetitions>(),
  syncCompetitionTeams: vi.fn<typeof syncCompetitionTeams>(),
  syncCompetitionMatches: vi.fn<typeof syncCompetitionMatches>(),
  syncCompetitionStandings: vi.fn<typeof syncCompetitionStandings>(),
  syncCompetitionScorers: vi.fn<typeof syncCompetitionScorers>(),
  syncCompetitionStandingsHistory: vi.fn<typeof syncCompetitionStandingsHistory>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/football-data/api', () => ({
  createFootballDataApi: () => ({ getCompetition: mocks.getCompetition }),
}));
vi.mock('./full', () => ({
  syncFullCompetitions: mocks.syncFullCompetitions,
}));
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

vi.mock('./standings-history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./standings-history')>()),
  syncCompetitionStandingsHistory: mocks.syncCompetitionStandingsHistory,
}));

function season(year: number) {
  return {
    id: year,
    startDate: `${year}-08-01`,
    endDate: `${year + 1}-06-01`,
    currentMatchday: null,
  };
}

const catalog = {
  id: 2021,
  name: 'Premier League',
  code: 'PL',
  emblem: null,
  currentSeason: season(2026),
  seasons: [2024, 2027, 2026, 2025, 2023, 2022, 2025].map(season),
};

beforeEach(() => {
  mocks.getCompetition.mockReset().mockImplementation(async (competitionCode) => ({
    ...catalog,
    code: competitionCode,
    currentSeason: season(competitionCode === 'CL' ? 2025 : 2026),
  }));
  mocks.syncCompetitionTeams
    .mockReset()
    .mockImplementation(async (competitionCode, { season } = {}) => ({
      competitionCode,
      season: season ?? 2026,
      teamCount: 1,
      teamIds: [57],
    }));
  mocks.syncCompetitionMatches
    .mockReset()
    .mockImplementation(async (competitionCode) => ({
      competitionCode,
      matchCount: 4,
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
        rowCount: 1,
      }));
  }
  mocks.syncCompetitionStandingsHistory
    .mockReset()
    .mockImplementation(async (competitionCode, { season, throughMatchday }) => {
      const code = historyCompetitionCodes.find((code) => code === competitionCode);
      if (code === undefined) throw new Error('Unexpected history competition');
      return {
        competitionCode: code,
        season,
        snapshots: Array.from({ length: throughMatchday }, (_, index) => ({
          matchday: index + 1,
          rowCount: code === 'FL1' ? 18 : 20,
        })),
      };
    });
  mocks.syncFullCompetitions.mockReset().mockImplementation(async (codes) => ({
    competitions: codes.map((competitionCode) => ({
      competitionCode,
      season: competitionCode === 'CL' ? 2025 : 2026,
      teamCount: 1,
      matchCount: 4,
      standingsCount: 1,
      scorerCount: 1,
    })),
    squadCount: 1,
  }));
});

describe('seed competition sync', () => {
  it('loads three distinct prior seasons per competition before the current full sync', async () => {
    const options = {
      signal: new AbortController().signal,
      requestCounter: { count: 0 },
    };
    const expectedHistory = [
      ['PL', 2023],
      ['PL', 2024],
      ['PL', 2025],
      ['CL', 2022],
      ['CL', 2023],
      ['CL', 2024],
    ] as const;

    const result = await syncSeedCompetitions([' pl ', 'CL', 'PL'], options);

    expect(result.history).toEqual(
      expectedHistory.map(([competitionCode, season]) => ({
        competitionCode,
        season,
        teamCount: 1,
        matchCount: 4,
        standingsCount: 1,
        scorerCount: 1,
      })),
    );
    expect(result.squadCount).toBe(1);
    expect(result.standingsHistory).toEqual([]);
    expect(mocks.syncCompetitionStandingsHistory).not.toHaveBeenCalled();
    expect(
      result.competitions.map(({ competitionCode, season }) => [
        competitionCode,
        season,
      ]),
    ).toEqual([
      ['PL', 2026],
      ['CL', 2025],
    ]);
    expect(mocks.getCompetition.mock.calls.map(([code]) => code)).toEqual([
      'PL',
      'CL',
    ]);
    for (const syncDataset of [
      mocks.syncCompetitionTeams,
      mocks.syncCompetitionMatches,
      mocks.syncCompetitionStandings,
      mocks.syncCompetitionScorers,
    ]) {
      expect(syncDataset).toHaveBeenCalledTimes(6);
      for (const [code, season] of expectedHistory) {
        expect(syncDataset).toHaveBeenCalledWith(code, { season, ...options });
      }
      expect(
        syncDataset.mock.calls.every(
          ([, callOptions]) =>
            callOptions?.requestCounter === options.requestCounter,
        ),
      ).toBe(true);
    }
    expect(mocks.syncFullCompetitions).toHaveBeenCalledExactlyOnceWith(
      ['PL', 'CL'],
      options,
    );
    expect(mocks.syncCompetitionScorers.mock.invocationCallOrder[5]).toBeLessThan(
      mocks.syncFullCompetitions.mock.invocationCallOrder[0]!,
    );
  });

  it('imports configured domestic rounds and refreshes the current bound before the final full sync', async () => {
    const calls = new Map<string, number>();
    mocks.getCompetition.mockImplementation(async (competitionCode) => {
      const count = (calls.get(competitionCode) ?? 0) + 1;
      calls.set(competitionCode, count);
      return {
        ...catalog,
        code: competitionCode,
        currentSeason: {
          ...season(competitionCode === 'CL' ? 2025 : 2026),
          currentMatchday: count === 1 ? 1 : 10,
        },
      };
    });
    const options = {
      includeStandingsHistory: true,
      signal: new AbortController().signal,
      requestCounter: { count: 0 },
    };
    const expected = [
      ['PL', 2023, 38],
      ['PL', 2024, 38],
      ['PL', 2025, 38],
      ['FL1', 2023, 34],
      ['FL1', 2024, 34],
      ['FL1', 2025, 34],
      ['PL', 2026, 10],
      ['FL1', 2026, 10],
    ] as const;

    const result = await syncSeedCompetitions(['PL', 'FL1', 'CL', 'ELC'], options);

    expect(mocks.syncCompetitionStandingsHistory.mock.calls).toEqual(
      expected.map(([code, season, throughMatchday]) => [
        code,
        {
          season,
          throughMatchday,
          signal: options.signal,
          requestCounter: options.requestCounter,
        },
      ]),
    );
    expect(
      result.standingsHistory.map(({ competitionCode, season, snapshots }) => [
        competitionCode,
        season,
        snapshots.length,
      ]),
    ).toEqual(expected);
    expect(mocks.getCompetition.mock.calls.map(([code]) => code)).toEqual([
      'PL',
      'FL1',
      'CL',
      'ELC',
      'PL',
      'FL1',
    ]);
    expect(
      mocks.syncCompetitionStandingsHistory.mock.invocationCallOrder[7],
    ).toBeLessThan(mocks.syncFullCompetitions.mock.invocationCallOrder[0]!);
  });

  it.each([null, 39])(
    'rejects an unavailable or unconfigured current round %s',
    async (currentMatchday) => {
      mocks.getCompetition.mockResolvedValue({
        ...catalog,
        currentSeason: { ...season(2026), currentMatchday },
      });

      await expect(
        syncSeedCompetitions(['PL'], {
          historySeasons: 0,
          includeStandingsHistory: true,
        }),
      ).rejects.toThrow('current matchday is unavailable for standings history');
      expect(mocks.syncCompetitionStandingsHistory).not.toHaveBeenCalled();
      expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
    },
  );

  it('represents a current season before round one with an empty history', async () => {
    mocks.getCompetition.mockResolvedValue({
      ...catalog,
      currentSeason: { ...season(2026), currentMatchday: 0 },
    });

    const result = await syncSeedCompetitions(['PL'], {
      historySeasons: 0,
      includeStandingsHistory: true,
    });

    expect(result.standingsHistory).toEqual([
      { competitionCode: 'PL', season: 2026, snapshots: [] },
    ]);
    expect(mocks.syncCompetitionStandingsHistory).not.toHaveBeenCalled();
    expect(mocks.syncFullCompetitions).toHaveBeenCalledOnce();
  });

  it('rejects a season change in the refreshed catalog before importing current rounds', async () => {
    mocks.getCompetition.mockResolvedValueOnce(catalog).mockResolvedValueOnce({
      ...catalog,
      currentSeason: { ...season(2027), currentMatchday: 1 },
    });

    await expect(
      syncSeedCompetitions(['PL'], {
        historySeasons: 0,
        includeStandingsHistory: true,
      }),
    ).rejects.toThrow('competition season changed during seed');
    expect(mocks.syncCompetitionStandingsHistory).not.toHaveBeenCalled();
    expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured historical season before importing its datasets', async () => {
    await expect(
      syncSeedCompetitions(['PL'], {
        historySeasons: 4,
        includeStandingsHistory: true,
      }),
    ).rejects.toThrow('standings history season is not configured');
    expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandingsHistory).not.toHaveBeenCalled();
    expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
  });

  it.each([
    { historySeasons: 0, years: [] },
    { historySeasons: 1, years: [2025] },
  ])(
    'supports a history depth of $historySeasons',
    async ({ historySeasons, years }) => {
      const result = await syncSeedCompetitions(['PL'], { historySeasons });

      expect(result.history.map(({ season }) => season)).toEqual(years);
      expect(mocks.syncCompetitionTeams).toHaveBeenCalledTimes(years.length);
      expect(mocks.syncFullCompetitions).toHaveBeenCalledOnce();
    },
  );

  it('propagates unavailable historical data before starting the current full sync', async () => {
    const error = new FootballDataHttpError(403, null);
    mocks.syncCompetitionMatches.mockRejectedValueOnce(error);

    await expect(syncSeedCompetitions(['PL', 'CL'])).rejects.toBe(error);

    expect(mocks.getCompetition).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionScorers).not.toHaveBeenCalled();
    expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
  });

  it('rejects a season change between the catalog and the current full sync', async () => {
    mocks.getCompetition.mockResolvedValueOnce({
      ...catalog,
      currentSeason: season(2025),
    });

    await expect(
      syncSeedCompetitions(['PL'], { historySeasons: 0 }),
    ).rejects.toThrow('competition season changed during seed');
  });

  it.each([-1, 1.5, NaN])(
    'rejects an invalid history depth %s before loading data',
    async (historySeasons) => {
      await expect(syncSeedCompetitions(['PL'], { historySeasons })).rejects.toThrow(
        RangeError,
      );

      expect(mocks.getCompetition).not.toHaveBeenCalled();
      expect(mocks.syncCompetitionTeams).not.toHaveBeenCalled();
      expect(mocks.syncFullCompetitions).not.toHaveBeenCalled();
    },
  );
});
