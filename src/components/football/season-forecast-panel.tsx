'use client';

import { useEffect, useRef, useState } from 'react';

import { LocalTime } from '@/components/common/local-time';
import { Button } from '@/components/ui/button';
import type { ChampionsLeagueForecastResult } from '@/lib/model/champions-league-forecast';
import type { StoredChampionsLeagueForecast } from '@/lib/model/champions-league-knockout-snapshot';
import type { LeagueSimulationResult } from '@/lib/model/league-simulation';
import type { RandomSeed } from '@/lib/model/seeded-random';
import {
  runSeasonForecastInWorker,
  type SeasonForecastProgress,
} from '@/lib/workers/run-season-forecast';
import type { SeasonForecastWorkerRequest } from '@/lib/workers/season-forecast-api';

type Forecast = LeagueSimulationResult | ChampionsLeagueForecastResult;
type PublishedForecast = LeagueSimulationResult | StoredChampionsLeagueForecast;
type TeamNames = Readonly<Partial<Record<number, string>>>;
type Calculation =
  | { status: 'idle' }
  | { status: 'running'; progress: SeasonForecastProgress }
  | { status: 'complete'; forecast: Forecast }
  | { status: 'cancelled' | 'unavailable' | 'error' };

const pointsFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const chanceFormat = new Intl.NumberFormat('ru-RU', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const rangeFormat = new Intl.NumberFormat('ru-RU', {
  style: 'percent',
  maximumFractionDigits: 2,
});

function ForecastProbabilityRanges({
  forecast,
  source,
  teamNames,
}: {
  forecast: Forecast;
  source: 'опубликовано' | 'пересчитано';
  teamNames: TeamNames;
}) {
  if (!('forecast' in forecast) || !forecast.forecast.unresolvedRankingRuns)
    return null;

  const { teams, unresolvedRankingRuns } = forecast.forecast;
  return (
    <details className="rounded-md border border-border px-3 py-2 text-body-sm">
      <summary className="cursor-pointer font-medium">
        Диапазоны вероятностей · {source}
      </summary>
      <p className="mt-2 text-muted-foreground">
        Решающее равенство в {unresolvedRankingRuns.toLocaleString('ru-RU')} из{' '}
        {forecast.forecast.runs.toLocaleString('ru-RU')} прогонов. Нижняя граница
        учитывает определившиеся исходы, верхняя включает возможные.
      </p>
      <ul className="mt-2 divide-y divide-border">
        {teams.flatMap(({ teamId, positionDistribution, zones }) =>
          [
            ...positionDistribution.map((entry) => ({
              ...entry,
              key: 'position-' + entry.position,
              label: entry.position + '-е место',
            })),
            ...zones.map((entry) => ({
              ...entry,
              key: 'zone-' + entry.from + '-' + entry.to + '-' + entry.zone,
            })),
          ].flatMap(({ key, label, probability, upperBound }) =>
            upperBound === undefined
              ? []
              : [
                  <li
                    key={teamId + ':' + key}
                    className="flex flex-wrap justify-between gap-x-3 py-1.5"
                  >
                    <span>
                      {teamNames[teamId] ?? `Клуб ${teamId}`} · {label}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      {rangeFormat.format(probability)}–
                      {rangeFormat.format(upperBound.probability)}
                    </span>
                  </li>,
                ],
          ),
        )}
      </ul>
    </details>
  );
}

function teamMetrics(forecast: Forecast) {
  return 'forecast' in forecast
    ? forecast.forecast.teams.map(
        ({ teamId, expectedPoints }) => [teamId, expectedPoints] as const,
      )
    : forecast.teams.map(
        ({ teamId, events }) => [teamId, events.champion.probability] as const,
      );
}

export function SeasonForecastPanel({
  published,
  teamNames,
}: {
  published: PublishedForecast;
  teamNames: TeamNames;
}) {
  const { dataCutoffMs, runs } = published.inputSnapshot;
  const activeRun = useRef<AbortController | null>(null);
  const [calculation, setCalculation] = useState<Calculation>({ status: 'idle' });

  useEffect(
    () => () => {
      const controller = activeRun.current;
      activeRun.current = null;
      controller?.abort();
    },
    [],
  );

  async function recalculate() {
    if (activeRun.current !== null) return;
    const controller = new AbortController();
    activeRun.current = controller;
    setCalculation({
      status: 'running',
      progress: { completedRuns: 0, totalRuns: runs },
    });

    try {
      const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
      const seed: RandomSeed = words.every((word) => word === 0)
        ? [1, 0, 0, 0]
        : [words[0]!, words[1]!, words[2]!, words[3]!];
      let request: SeasonForecastWorkerRequest;
      if ('forecast' in published) {
        request = {
          kind: 'league-table',
          input: { ...published.inputSnapshot, seed },
        };
      } else {
        if (published.knockoutSnapshot === undefined) {
          setCalculation({ status: 'unavailable' });
          return;
        }
        request = {
          kind: 'champions-league-stages',
          input: {
            ...published.inputSnapshot,
            seed,
            knockoutSnapshot: published.knockoutSnapshot,
          },
        };
      }

      const update = await runSeasonForecastInWorker(request, {
        signal: controller.signal,
        onProgress(progress) {
          if (activeRun.current === controller)
            setCalculation({ status: 'running', progress });
        },
      });
      if (activeRun.current !== controller) return;
      setCalculation(
        update.status === 'complete'
          ? { status: 'complete', forecast: update.result }
          : { status: 'unavailable' },
      );
    } catch {
      if (activeRun.current === controller) setCalculation({ status: 'error' });
    } finally {
      if (activeRun.current === controller) activeRun.current = null;
    }
  }

  function cancel() {
    const controller = activeRun.current;
    activeRun.current = null;
    controller?.abort();
    setCalculation({ status: 'cancelled' });
  }

  const leagueTable = 'forecast' in published;
  const metric = leagueTable ? 'Ожидаемые очки' : 'Шанс на титул';
  const format = leagueTable ? pointsFormat : chanceFormat;
  const publishedRows = teamMetrics(published).sort(
    ([firstId, first], [secondId, second]) => second - first || firstId - secondId,
  );
  const local =
    calculation.status === 'complete'
      ? new Map(teamMetrics(calculation.forecast))
      : null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-body-sm text-muted-foreground">
        Данные на{' '}
        <LocalTime
          value={new Date(dataCutoffMs).toISOString()}
          options={{ dateStyle: 'medium', timeStyle: 'short' }}
        />
        {' · '}
        {runs.toLocaleString('ru-RU')} прогонов
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {leagueTable || published.knockoutSnapshot !== undefined ? (
          <>
            <Button
              type="button"
              size="lg"
              onClick={recalculate}
              disabled={calculation.status === 'running'}
            >
              Пересчитать
            </Button>
            {calculation.status === 'running' && (
              <Button type="button" size="lg" variant="outline" onClick={cancel}>
                Отменить
              </Button>
            )}
          </>
        ) : (
          <p className="text-body-sm text-muted-foreground">
            Для этого прогноза не сохранились данные плей-офф для пересчёта.
          </p>
        )}
      </div>
      {calculation.status === 'running' && (
        <div className="flex flex-wrap items-center gap-2 text-body-sm">
          <progress
            aria-label="Прогресс пересчёта"
            className="accent-primary"
            value={calculation.progress.completedRuns}
            max={calculation.progress.totalRuns}
          />
          <span>
            {calculation.progress.completedRuns} из {calculation.progress.totalRuns}
          </span>
        </div>
      )}
      {calculation.status === 'cancelled' && (
        <p role="status" className="text-body-sm">
          Пересчёт отменён.
        </p>
      )}
      {calculation.status === 'complete' && (
        <p role="status" className="sr-only">
          Пересчёт завершён.
        </p>
      )}
      {calculation.status === 'unavailable' && (
        <p role="status" className="text-body-sm">
          По этому снимку локальный прогноз недоступен.
        </p>
      )}
      {calculation.status === 'error' && (
        <p role="alert" className="text-body-sm">
          Не удалось пересчитать прогноз.
        </p>
      )}
      <ForecastProbabilityRanges
        forecast={published}
        source="опубликовано"
        teamNames={teamNames}
      />
      {calculation.status === 'complete' && (
        <ForecastProbabilityRanges
          forecast={calculation.forecast}
          source="пересчитано"
          teamNames={teamNames}
        />
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-body-sm tabular-nums">
          <caption className="pb-2 text-left font-semibold">{metric}</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 text-left font-medium">
                Клуб
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Опубликовано
              </th>
              {local !== null && (
                <th scope="col" className="py-2 pl-4 text-right font-medium">
                  Пересчитано
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {publishedRows.map(([id, value]) => {
              const recalculated = local?.get(id);
              return (
                <tr key={id} className="border-t border-border">
                  <th scope="row" className="py-2 pr-4 text-left font-medium">
                    {teamNames[id] ?? `Клуб ${id}`}
                  </th>
                  <td className="py-2 text-right">{format.format(value)}</td>
                  {local !== null && (
                    <td className="py-2 pl-4 text-right">
                      {recalculated === undefined
                        ? '—'
                        : format.format(recalculated)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
