import 'server-only';

import type { ChampionsLeagueForecastInput } from '@/lib/model/champions-league-forecast';
import { snapshotChampionsLeagueKnockout } from '@/lib/model/champions-league-knockout-snapshot';
import type { RandomSeed } from '@/lib/model/seeded-random';

import {
  calculateAndStoreSeasonForecast,
  type SeasonForecastStorageResult,
} from './calculate-and-store';
import { loadChampionsLeagueKnockoutObservations } from './load-knockout-observations';
import {
  loadChampionsLeaguePhaseInput,
  type LeagueForecastInputResult,
} from './load-league-input';

const drawStages = [
  ['PLAYOFFS', 'playOff'],
  ['LAST_16', 'roundOf16'],
  ['QUARTER_FINALS', 'quarterFinals'],
  ['SEMI_FINALS', 'semiFinals'],
] as const;

type ChampionsLeagueForecastOptions = Pick<
  ChampionsLeagueForecastInput,
  'officialDraws' | 'tieBreakContext'
> &
  Readonly<{ before: Date; seed: RandomSeed; runs?: number }>;

type CalculationResult =
  | SeasonForecastStorageResult
  | Exclude<LeagueForecastInputResult, { status: 'ready' }>
  | { status: 'unavailable'; reason: 'incomplete-league-phase' }
  | {
      status: 'unavailable';
      reason: 'official-draw-required';
      stage: (typeof drawStages)[number][0];
    };

/** Calculate and save a Champions League forecast from data observed before the cutoff. */
export async function calculateChampionsLeagueForecast(
  season: number,
  options: ChampionsLeagueForecastOptions,
): Promise<CalculationResult> {
  // Draw and tie-break context are supplied by the caller for the same cutoff.
  const { before, seed, runs, officialDraws, tieBreakContext } =
    structuredClone(options);
  const phase = await loadChampionsLeaguePhaseInput(season, { before, seed });
  if (phase.status !== 'ready') return phase;

  const observations = await loadChampionsLeagueKnockoutObservations(season, before);
  if (observations === null) return { status: 'unsupported' };

  const drawnStages = new Set(
    observations
      .filter(
        ({ homeTeamId, awayTeamId }) =>
          homeTeamId !== null && awayTeamId !== null && homeTeamId !== awayTeamId,
      )
      .map(({ stage }) => stage),
  );
  const lastDrawnStage = drawnStages.has('FINAL')
    ? drawStages.length - 1
    : drawStages.findLastIndex(([stage]) => drawnStages.has(stage));
  for (const [stage, draw] of drawStages.slice(0, lastDrawnStage + 1)) {
    if (officialDraws?.[draw] === undefined)
      return { status: 'unavailable', reason: 'official-draw-required', stage };
  }

  const { baseline, fixtures, modelVersion, dataCutoffMs, sampling } = phase.input;
  if (
    officialDraws !== undefined &&
    Object.values(officialDraws).some((draw) => draw !== undefined) &&
    fixtures.some(({ kind }) => kind === 'forecast')
  )
    return { status: 'unavailable', reason: 'incomplete-league-phase' };

  return calculateAndStoreSeasonForecast({
    kind: 'champions-league-stages',
    input: {
      season,
      modelVersion,
      dataCutoffMs,
      seed,
      runs,
      sampling,
      baseline,
      fixtures,
      officialDraws,
      tieBreakContext,
      knockoutSnapshot: snapshotChampionsLeagueKnockout(
        phase.knockoutStrengths,
        observations,
      ),
    },
  });
}
