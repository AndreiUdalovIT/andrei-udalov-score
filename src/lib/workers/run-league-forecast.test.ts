import { expose } from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLeagueSimulation,
  type LeagueSimulationInput,
} from '../model/league-simulation';
import type { SeasonCalendarFixture } from '../model/season-calendar-sampler';
import { projectSeasonStats } from '../model/season-stats';
import { createLeagueForecastWorkerApi } from './league-forecast-api';
import { runLeagueForecastInWorker } from './run-league-forecast';

const workers: TestWorker[] = [];

/** Use a real message channel to exercise Comlink without a browser. */
class TestWorker extends EventTarget {
  readonly channel = new MessageChannel();
  readonly api = createLeagueForecastWorkerApi();
  readonly advance = vi.spyOn(this.api, 'advance');
  readonly terminate = vi.fn(() => {
    this.channel.port1.close();
    this.channel.port2.close();
  });

  constructor() {
    super();
    workers.push(this);
    expose(this.api, this.channel.port2);
    this.channel.port1.addEventListener('message', (event) => {
      this.dispatchEvent(new MessageEvent('message', { data: event.data }));
    });
    this.channel.port1.start();
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    this.channel.port1.postMessage(message, transfer);
  }
}

beforeEach(() => {
  vi.stubGlobal('Worker', TestWorker);
});

afterEach(() => {
  for (const worker of workers) {
    worker.channel.port1.close();
    worker.channel.port2.close();
  }
  workers.length = 0;
  vi.unstubAllGlobals();
});

function leagueInput(): LeagueSimulationInput {
  const teamIds = Array.from({ length: 20 }, (_, index) => index + 1);
  const fixtures: SeasonCalendarFixture[] = teamIds.flatMap((homeTeamId) =>
    teamIds
      .filter((awayTeamId) => awayTeamId !== homeTeamId)
      .map((awayTeamId) => {
        const fixture = {
          id: (homeTeamId - 1) * teamIds.length + awayTeamId,
          homeTeamId,
          awayTeamId,
        };
        return fixture.id === 2
          ? { ...fixture, kind: 'forecast', homeRate90: 1.5, awayRate90: 0.8 }
          : {
              ...fixture,
              kind: 'known-result',
              homeGoals90: homeTeamId < awayTeamId ? 8 : 0,
              awayGoals90: homeTeamId < awayTeamId ? 0 : 8,
            };
      }),
  );
  const empty = teamIds.map((teamId) => ({
    teamId,
    playedGames: 0,
    won: 0,
    draw: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  const baseline = projectSeasonStats(
    empty,
    fixtures
      .filter((fixture) => fixture.kind === 'known-result')
      .map((fixture) => ({ ...fixture, source: 'simulated' })),
  )!;

  return {
    competitionCode: 'PL',
    season: 2026,
    modelVersion: 'poisson-v1',
    dataCutoffMs: Date.parse('2026-11-12T00:00:00Z'),
    seed: [1, 2, 3, 4],
    runs: 215,
    sampling: { maxGoals: 64, tailTolerance: 1e-10 },
    baseline,
    fixtures,
  };
}

describe('runLeagueForecastInWorker', () => {
  it('reports bounded batches and reproduces the direct seeded calculation', async () => {
    const input = leagueInput();
    const direct = createLeagueSimulation(input);
    direct?.advance(input.runs);
    const onProgress = vi.fn();

    const output = await runLeagueForecastInWorker(input, { onProgress });

    expect(output.status).toBe('complete');
    if (output.status !== 'complete') throw new Error('expected complete forecast');
    expect(output.result).toEqual(direct?.result());
    expect(onProgress.mock.calls).toEqual(
      [0, 100, 200, 215].map((completedRuns) => [{ completedRuns, totalRuns: 215 }]),
    );
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('terminates an aborted forecast and leaves a later task independent', async () => {
    const controller = new AbortController();
    const stopped = vi.fn(({ completedRuns }) => {
      if (completedRuns === 100) controller.abort();
    });
    const input = leagueInput();

    await expect(
      runLeagueForecastInWorker(input, {
        onProgress: stopped,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.advance).toHaveBeenCalledOnce();
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledTimes(2);

    await expect(
      runLeagueForecastInWorker({ ...input, runs: 1 }),
    ).resolves.toMatchObject({
      status: 'complete',
      result: { inputSnapshot: { runs: 1 } },
    });
    expect(workers[1]?.terminate).toHaveBeenCalledOnce();
  });

  it('does not create a worker for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runLeagueForecastInWorker(leagueInput(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(0);
  });

  it('reports unsupported inputs and propagates model errors', async () => {
    const input = leagueInput();
    await expect(
      runLeagueForecastInWorker({ ...input, season: 2001 }),
    ).resolves.toEqual({
      status: 'unsupported',
    });
    await expect(
      runLeagueForecastInWorker({ ...input, seed: [0, 0, 0, 0] }),
    ).rejects.toThrow('seed must contain four unsigned 32-bit integers');
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror'])(
    'rejects a pending request on %s',
    async (type) => {
      const output = runLeagueForecastInWorker(leagueInput());
      workers[0]?.dispatchEvent(new Event(type));

      await expect(output).rejects.toThrow('league forecast worker failed');
      expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    },
  );
});
