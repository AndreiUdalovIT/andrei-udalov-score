import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  CHAMPIONS_LEAGUE_FORECAST_ALGORITHM,
  type ChampionsLeagueForecastResult,
} from '@/lib/model/champions-league-forecast';
import {
  snapshotChampionsLeagueKnockout,
  type StoredChampionsLeagueForecast,
} from '@/lib/model/champions-league-knockout-snapshot';
import { CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM } from '@/lib/model/champions-league-simulation';
import {
  LEAGUE_FORECAST_ACCUMULATION_ALGORITHM,
  LEAGUE_POINTS_INTERVAL_METHOD,
} from '@/lib/model/league-forecast-accumulator';
import {
  LEAGUE_SIMULATION_ALGORITHM,
  type LeagueSimulationResult,
} from '@/lib/model/league-simulation';
import { SEASON_LOTS_SAMPLING_ALGORITHM } from '@/lib/model/season-lots-sampler';
import { SEEDED_RANDOM_ALGORITHM } from '@/lib/model/seeded-random';
import { runSeasonForecastInWorker } from '@/lib/workers/run-season-forecast';
import type { SeasonForecastWorkerResult } from '@/lib/workers/season-forecast-api';

import { SeasonForecastPanel } from './season-forecast-panel';

vi.mock('@/lib/workers/run-season-forecast', () => ({
  runSeasonForecastInWorker: vi.fn(),
}));

const run = vi.mocked(runSeasonForecastInWorker);
const cutoff = '2026-11-24T12:00:00.000Z';
const input = {
  season: 2026,
  dataCutoffMs: Date.parse(cutoff),
  modelVersion: 'poisson-v1',
  runs: 1_000,
  seed: [1, 2, 3, 4] as const,
  baseline: [],
  fixtures: [],
  sampling: { maxGoals: 64, tailTolerance: 1e-10 },
};
const league: LeagueSimulationResult = {
  algorithm: 'seeded-fixed-rate-league-simulation-v4',
  inputSnapshot: {
    ...input,
    competitionCode: 'PL',
    fixedContext: {
      championsLeagueTieBreaks: [],
      laLigaFairPlay: [],
      ligue1Discipline: [],
      serieAUefaFinalistTeamIds: null,
      serieAPlayOffScenarios: [],
    },
  },
  versions: {
    random: SEEDED_RANDOM_ALGORITHM,
    calendar: 'calendar',
    score: 'score',
    ranking: 'ranking',
    lots: SEASON_LOTS_SAMPLING_ALGORITHM,
    knockout: null,
  },
  lotPolicy: 'simulate-eligible-uniform-lots',
  samplingBounds: { perRun: 0, allRuns: 0 },
  forecast: {
    algorithm: 'complete-league-empirical-summary-v2',
    pointsIntervalMethod: LEAGUE_POINTS_INTERVAL_METHOD,
    competitionCode: 'PL',
    season: 2026,
    runs: input.runs,
    qualificationNote: null,
    teams: [
      {
        teamId: 1,
        expectedPoints: 71.8,
        pointsInterval80: { lower: 67, upper: 76 },
        positionDistribution: [],
        sharedPositionDistribution: [],
        zones: [],
      },
    ],
  },
};
const reachedStage = { probability: 1, count: input.runs };
const championsLeague: ChampionsLeagueForecastResult = {
  algorithm: CHAMPIONS_LEAGUE_FORECAST_ALGORITHM,
  inputSnapshot: input,
  versions: {
    random: SEEDED_RANDOM_ALGORITHM,
    simulation: CHAMPIONS_LEAGUE_SIMULATION_ALGORITHM,
  },
  samplingBounds: { perRun: 0, allRuns: 0 },
  teams: [
    {
      teamId: 1,
      events: {
        playOff: reachedStage,
        directRoundOf16: reachedStage,
        roundOf16: reachedStage,
        quarterFinals: reachedStage,
        semiFinals: reachedStage,
        final: reachedStage,
        champion: { probability: 0.25, count: 250 },
      },
    },
  ],
};

beforeEach(() => {
  run.mockReset();
});

it('compares the local simulation with the unchanged published forecast', async () => {
  const pending = Promise.withResolvers<SeasonForecastWorkerResult>();
  run.mockReturnValueOnce(pending.promise);
  const user = userEvent.setup();
  const { container } = render(
    <SeasonForecastPanel published={league} teamNames={{ 1: 'Арсенал' }} />,
  );

  const table = screen.getByRole('table', { name: 'Ожидаемые очки' });
  const team = within(table).getByRole('row', { name: /Арсенал/ });
  expect(within(team).getByRole('cell', { name: '71,8' })).toBeVisible();
  expect(container.querySelector('time')).toHaveAttribute('datetime', cutoff);

  await user.click(screen.getByRole('button', { name: 'Пересчитать' }));
  const [request, options] = run.mock.calls[0]!;
  expect(request.kind).toBe('league-table');
  expect(request.input).toEqual({
    ...league.inputSnapshot,
    seed: expect.any(Array),
  });
  expect(request.input.seed).not.toEqual(league.inputSnapshot.seed);

  act(() => options?.onProgress?.({ completedRuns: 100, totalRuns: input.runs }));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100');

  await act(async () =>
    pending.resolve({
      status: 'complete',
      result: {
        ...league,
        forecast: {
          ...league.forecast,
          teams: [{ ...league.forecast.teams[0]!, expectedPoints: 72.2 }],
        },
      },
    }),
  );
  expect(
    within(table).getByRole('columnheader', { name: 'Опубликовано' }),
  ).toBeVisible();
  expect(
    within(table).getByRole('columnheader', { name: 'Пересчитано' }),
  ).toBeVisible();
  expect(
    within(team)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['71,8', '72,2']);
});

it('cancels the worker and ignores a late result', async () => {
  const pending = Promise.withResolvers<SeasonForecastWorkerResult>();
  run.mockReturnValueOnce(pending.promise);
  const user = userEvent.setup();
  render(<SeasonForecastPanel published={league} teamNames={{}} />);

  await user.click(screen.getByRole('button', { name: 'Пересчитать' }));
  await user.click(screen.getByRole('button', { name: 'Отменить' }));
  expect(run.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent('Пересчёт отменён.');

  await act(async () => pending.resolve({ status: 'complete', result: league }));
  expect(screen.queryByRole('columnheader', { name: 'Пересчитано' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Пересчитать' })).toBeEnabled();
});

it('shows a worker failure and allows another attempt', async () => {
  run.mockRejectedValueOnce(new Error('worker failed'));
  render(<SeasonForecastPanel published={league} teamNames={{}} />);

  const button = screen.getByRole('button', { name: 'Пересчитать' });
  await userEvent.setup().click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Не удалось пересчитать прогноз.',
  );
  expect(button).toBeEnabled();
  expect(screen.getByRole('columnheader', { name: 'Опубликовано' })).toBeVisible();
});

it('displays old Champions League forecasts without offering replay', () => {
  render(
    <SeasonForecastPanel published={championsLeague} teamNames={{ 1: 'Арсенал' }} />,
  );
  const table = screen.getByRole('table', { name: 'Шанс на титул' });
  expect(within(table).getByRole('cell', { name: /25\s*%/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Пересчитать' })).toBeNull();
  expect(screen.getByText(/не сохранились данные плей-офф/)).toBeVisible();
});

it('sends the published knockout snapshot to the Champions League worker', async () => {
  const knockoutSnapshot = snapshotChampionsLeagueKnockout(
    {
      league: {
        homeGoalsPerMatch: 1.4,
        awayGoalsPerMatch: 0.9,
        matchCount: 0,
        effectiveMatchCount: 0,
      },
      teams: [],
    },
    [],
  );
  const published: StoredChampionsLeagueForecast = {
    ...championsLeague,
    knockoutSnapshot,
  };
  run.mockResolvedValueOnce({ status: 'unsupported' });
  render(<SeasonForecastPanel published={published} teamNames={{}} />);

  await userEvent.setup().click(screen.getByRole('button', { name: 'Пересчитать' }));
  const [request] = run.mock.calls[0]!;
  expect(request).toEqual({
    kind: 'champions-league-stages',
    input: { ...input, seed: expect.any(Array), knockoutSnapshot },
  });
  expect(screen.getByRole('status')).toHaveTextContent(
    'По этому снимку локальный прогноз недоступен.',
  );
});

it('shows bounds only for affected events and keeps published and worker ranges separate', async () => {
  const published: LeagueSimulationResult = {
    ...league,
    algorithm: LEAGUE_SIMULATION_ALGORITHM,
    forecast: {
      ...league.forecast,
      algorithm: LEAGUE_FORECAST_ACCUMULATION_ALGORITHM,
      unresolvedRankingRuns: 1,
      teams: [
        {
          ...league.forecast.teams[0]!,
          positionDistribution: [
            {
              position: 4,
              count: 200,
              probability: 0.2,
              upperBound: { count: 201, probability: 0.201 },
            },
          ],
          zones: [
            {
              from: 1,
              to: 4,
              zone: 'ucl',
              label: 'Лига чемпионов',
              count: 500,
              probability: 0.5,
              upperBound: { count: 501, probability: 0.501 },
            },
            {
              from: 18,
              to: 20,
              zone: 'releg',
              label: 'Вылет в Чемпионшип',
              count: 0,
              probability: 0,
            },
          ],
        },
      ],
    },
  };
  run.mockResolvedValueOnce({
    status: 'complete',
    result: {
      ...published,
      forecast: {
        ...published.forecast,
        teams: [
          {
            ...published.forecast.teams[0]!,
            positionDistribution: [
              {
                position: 4,
                count: 210,
                probability: 0.21,
                upperBound: { count: 211, probability: 0.211 },
              },
            ],
          },
        ],
      },
    },
  });
  const user = userEvent.setup();
  render(<SeasonForecastPanel published={published} teamNames={{ 1: 'Арсенал' }} />);

  await user.click(screen.getByText('Диапазоны вероятностей · опубликовано'));
  expect(screen.getByText('Арсенал · 4-е место')).toBeVisible();
  expect(screen.getByText(/20\s*%–20,1\s*%/)).toBeVisible();
  expect(screen.getByText(/50\s*%–50,1\s*%/)).toBeVisible();
  expect(screen.queryByText(/Вылет в Чемпионшип/)).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Пересчитать' }));
  await user.click(await screen.findByText('Диапазоны вероятностей · пересчитано'));
  expect(screen.getByText(/20\s*%–20,1\s*%/)).toBeVisible();
  expect(screen.getByText(/21\s*%–21,1\s*%/)).toBeVisible();
  expect(screen.getByRole('table', { name: 'Ожидаемые очки' })).toBeVisible();
});
