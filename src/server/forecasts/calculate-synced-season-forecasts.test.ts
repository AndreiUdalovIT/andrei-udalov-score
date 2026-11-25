import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calculateAndStoreSeasonForecast } from './calculate-and-store';
import { calculateChampionsLeagueForecast } from './calculate-champions-league-forecast';
import { calculateSyncedSeasonForecasts } from './calculate-synced-season-forecasts';
import { loadLeagueForecastInput } from './load-league-input';

vi.mock('server-only', () => ({}));
vi.mock('./calculate-and-store', () => ({
  calculateAndStoreSeasonForecast: vi.fn(),
}));
vi.mock('./calculate-champions-league-forecast', () => ({
  calculateChampionsLeagueForecast: vi.fn(),
}));
vi.mock('./load-league-input', () => ({ loadLeagueForecastInput: vi.fn() }));

const loadLeague = vi.mocked(loadLeagueForecastInput);
const storeLeague = vi.mocked(calculateAndStoreSeasonForecast);
const runChampionsLeague = vi.mocked(calculateChampionsLeagueForecast);

beforeEach(() => {
  loadLeague.mockReset();
  storeLeague.mockReset();
  runChampionsLeague.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calculateSyncedSeasonForecasts', () => {
  it('uses the synced seasons, one cutoff and valid seeds for the supported tournaments', async () => {
    loadLeague.mockImplementationOnce(async (competitionCode, season, options) => ({
      status: 'ready',
      input: {
        competitionCode,
        season,
        modelVersion: 'poisson-v1',
        dataCutoffMs: options.before.getTime(),
        seed: options.seed,
        sampling: { tailTolerance: 1e-10, maxGoals: 64 },
        baseline: [],
        fixtures: [],
      },
    }));
    storeLeague.mockResolvedValueOnce({ status: 'stored', id: 21 });
    runChampionsLeague.mockResolvedValueOnce({ status: 'stored', id: 22 });

    await calculateSyncedSeasonForecasts([
      { competitionCode: 'PL', season: 2026 },
      { competitionCode: 'ELC', season: 2026 },
      { competitionCode: 'CL', season: 2025 },
    ]);

    expect(loadLeague).toHaveBeenCalledExactlyOnceWith(
      'PL',
      2026,
      expect.any(Object),
    );
    expect(runChampionsLeague).toHaveBeenCalledExactlyOnceWith(
      2025,
      expect.any(Object),
    );
    const leagueOptions = loadLeague.mock.calls[0]![2];
    const championsLeagueOptions = runChampionsLeague.mock.calls[0]![1];
    expect(championsLeagueOptions.before).toEqual(leagueOptions.before);
    for (const options of [leagueOptions, championsLeagueOptions]) {
      expect(options.seed).toHaveLength(4);
      expect(
        options.seed.every(
          (word) => Number.isInteger(word) && word >= 0 && word <= 0xffff_ffff,
        ),
      ).toBe(true);
      expect(options.seed.some((word) => word > 0)).toBe(true);
    }
    expect(storeLeague).toHaveBeenCalledExactlyOnceWith({
      kind: 'league-table',
      input: expect.objectContaining({
        competitionCode: 'PL',
        season: 2026,
        dataCutoffMs: leagueOptions.before.getTime(),
        seed: leagueOptions.seed,
      }),
    });
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      'Stored season forecast for PL 2026 (ID 21).',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      'Stored season forecast for CL 2025 (ID 22).',
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('prints the reason a forecast is unavailable and omits a row when preparation fails', async () => {
    loadLeague.mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'incomplete-calendar',
    });
    runChampionsLeague.mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'official-draw-required',
      stage: 'PLAYOFFS',
    });

    await calculateSyncedSeasonForecasts([
      { competitionCode: 'SA', season: 2026 },
      { competitionCode: 'CL', season: 2026 },
    ]);

    expect(storeLeague).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenNthCalledWith(
      1,
      'Season forecast skipped for SA 2026: incomplete-calendar.',
    );
    expect(console.log).toHaveBeenNthCalledWith(
      2,
      'Season forecast skipped for CL 2026: official-draw-required (PLAYOFFS).',
    );
  });

  it('continues after a tournament error and suppresses driver details', async () => {
    loadLeague.mockRejectedValueOnce(new Error('private database details'));
    runChampionsLeague.mockResolvedValueOnce({
      status: 'unavailable',
      detail: {
        status: 'unavailable',
        stage: 'league-phase',
        reason: 'unresolved-seeding',
        groups: [],
        run: 1,
        seed: [1, 2, 3, 4],
      },
    });

    await expect(
      calculateSyncedSeasonForecasts([
        { competitionCode: 'PL', season: 2026 },
        { competitionCode: 'CL', season: 2026 },
      ]),
    ).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      'Season forecast failed for PL 2026.',
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      'Season forecast skipped for CL 2026: unresolved-seeding (league-phase).',
    );
  });
});
