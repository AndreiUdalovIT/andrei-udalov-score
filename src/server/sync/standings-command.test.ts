import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { syncCompetitionStandings } from './standings';
import { runStandingsCommand } from './standings-command';

const mocks = vi.hoisted(() => ({
  loadEnvConfig: vi.fn(),
  syncCompetitionStandings: vi.fn<typeof syncCompetitionStandings>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@next/env', () => ({ loadEnvConfig: mocks.loadEnvConfig }));
vi.mock('./standings', () => ({
  syncCompetitionStandings: mocks.syncCompetitionStandings,
}));

beforeEach(() => {
  mocks.loadEnvConfig.mockReset();
  mocks.syncCompetitionStandings.mockReset().mockResolvedValue({
    competitionCode: 'PL',
    season: 2025,
    rowCount: 20,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standings sync command', () => {
  it('passes the requested competition and season after loading the environment', async () => {
    expect(
      await runStandingsCommand(['--competition', ' pl ', '--season', '2025']),
    ).toBe(0);

    expect(mocks.loadEnvConfig).toHaveBeenCalledOnce();
    expect(mocks.syncCompetitionStandings).toHaveBeenCalledExactlyOnceWith('PL', {
      season: 2025,
      matchday: undefined,
    });
    expect(mocks.loadEnvConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncCompetitionStandings.mock.invocationCallOrder[0]!,
    );
    expect(console.log).toHaveBeenCalledWith(
      'Synced 20 standings rows for PL 2025.',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('passes an explicit round and identifies reconstructed history in the output', async () => {
    expect(
      await runStandingsCommand([
        '--competition',
        'PL',
        '--season',
        '2025',
        '--matchday',
        '10',
      ]),
    ).toBe(0);

    expect(mocks.syncCompetitionStandings).toHaveBeenCalledExactlyOnceWith('PL', {
      season: 2025,
      matchday: 10,
    });
    expect(console.log).toHaveBeenCalledWith(
      'Captured 20 reconstructed standings rows for PL 2025, matchday 10.',
    );
  });

  it('imports a configured range through the CLI with the expected table shape', async () => {
    expect(
      await runStandingsCommand([
        '--competition',
        ' pl ',
        '--season',
        '2025',
        '--through-matchday',
        '3',
      ]),
    ).toBe(0);

    expect(mocks.syncCompetitionStandings.mock.calls).toEqual(
      [1, 2, 3].map((matchday) => [
        'PL',
        {
          season: 2025,
          matchday,
          expectedTable: { teamCount: 20, stage: 'REGULAR_SEASON' },
          signal: undefined,
          requestCounter: undefined,
        },
      ]),
    );
    expect(console.log).toHaveBeenCalledWith(
      'Captured 3 reconstructed standings snapshots for PL 2025 (matchdays 1-3).',
    );
  });

  it('stops a range after a failed round and reports a fixed error', async () => {
    mocks.syncCompetitionStandings
      .mockResolvedValueOnce({ competitionCode: 'PL', season: 2025, rowCount: 20 })
      .mockRejectedValueOnce(new Error('Sensitive database details'));

    expect(
      await runStandingsCommand([
        '--competition',
        'PL',
        '--season',
        '2025',
        '--through-matchday',
        '3',
      ]),
    ).toBe(1);

    expect(mocks.syncCompetitionStandings).toHaveBeenCalledTimes(2);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Standings sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
    );
  });

  it.each([
    { competition: 'PL', season: '2025', through: '39' },
    { competition: 'BL1', season: '2025', through: '35' },
    { competition: 'CL', season: '2025', through: '3' },
    { competition: 'PL', season: '2022', through: '3' },
  ])(
    'rejects an unconfigured range for $competition $season through $through',
    async ({ competition, season, through }) => {
      expect(
        await runStandingsCommand([
          '--competition',
          competition,
          '--season',
          season,
          '--through-matchday',
          through,
        ]),
      ).toBe(1);
      expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
    },
  );

  it('shows help without loading environment variables or running the sync', async () => {
    expect(await runStandingsCommand(['--help'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ['--competition', 'PL', '--matchday', '10'],
    ['--competition', 'PL', '--through-matchday', '3'],
    [
      '--competition',
      'PL',
      '--season',
      '2025',
      '--matchday',
      '1',
      '--through-matchday',
      '3',
    ],
    ['--competition', 'PL', '--season', '2025', '--matchday', '0'],
    ['--competition', 'PL', '--season', '2025', '--matchday', '1.5'],
    ['--competition', 'PL', '--season', '2025', '--matchday', '9007199254740992'],
  ])('rejects invalid arguments before loading the environment', async (...args) => {
    expect(await runStandingsCommand(args)).toBe(2);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid arguments.'),
    );
    expect(mocks.loadEnvConfig).not.toHaveBeenCalled();
    expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
  });

  it.each(['environment', 'sync'])(
    'reports a failed %s without exposing its details',
    async (stage) => {
      const error = new Error('Sensitive connection details');
      if (stage === 'environment') {
        mocks.loadEnvConfig.mockImplementationOnce(() => {
          throw error;
        });
      } else {
        mocks.syncCompetitionStandings.mockRejectedValueOnce(error);
      }

      expect(await runStandingsCommand(['--competition', 'PL'])).toBe(1);

      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        'Standings sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
      );
      expect(console.log).not.toHaveBeenCalled();
      if (stage === 'environment') {
        expect(mocks.syncCompetitionStandings).not.toHaveBeenCalled();
      }
    },
  );
});
