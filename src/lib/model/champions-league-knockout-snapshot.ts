import type {
  ChampionsLeagueForecastInput,
  ChampionsLeagueForecastResult,
} from './champions-league-forecast';

import {
  createChampionsLeagueKnockoutForecasts,
  type ChampionsLeagueKnockoutStrengths,
} from './champions-league-knockout-forecasts';
import { createChampionsLeagueKnockoutMatchProviders } from './champions-league-match-providers';
import type { ChampionsLeagueKnockoutObservation } from './champions-league-knockout-observation';

const knockoutSnapshotVersion = 'ucl-observed-poisson-knockout-v1';

type StoredObservation = Omit<
  ChampionsLeagueKnockoutObservation,
  'utcDate' | 'observedAt'
> & {
  readonly kickoffMs: number;
  readonly observedAtMs: number;
};

type ChampionsLeagueKnockoutSnapshot = {
  readonly version: typeof knockoutSnapshotVersion;
  readonly strengths: ChampionsLeagueKnockoutStrengths;
  readonly observations: readonly StoredObservation[];
};

export type ReplayableChampionsLeagueInput = Omit<
  ChampionsLeagueForecastInput,
  'matches'
> & {
  readonly knockoutSnapshot: ChampionsLeagueKnockoutSnapshot;
};

export type StoredChampionsLeagueForecast = ChampionsLeagueForecastResult & {
  /** Older results may have been calculated with caller-supplied providers. */
  readonly knockoutSnapshot?: ChampionsLeagueKnockoutSnapshot;
};

export function snapshotChampionsLeagueKnockout(
  strengths: ChampionsLeagueKnockoutStrengths,
  observations: readonly ChampionsLeagueKnockoutObservation[],
): ChampionsLeagueKnockoutSnapshot {
  return {
    version: knockoutSnapshotVersion,
    strengths,
    observations: observations.map(({ utcDate, observedAt, ...match }) => ({
      ...match,
      kickoffMs: utcDate.getTime(),
      observedAtMs: observedAt.getTime(),
    })),
  };
}

/** Rebuild match providers from the same JSON data stored with a forecast. */
export function restoreChampionsLeagueForecastInput({
  knockoutSnapshot,
  ...input
}: ReplayableChampionsLeagueInput): ChampionsLeagueForecastInput {
  if (knockoutSnapshot.version !== knockoutSnapshotVersion)
    throw new RangeError('unsupported Champions League knockout snapshot version');

  const observations = knockoutSnapshot.observations.map(
    ({ kickoffMs, observedAtMs, ...match }) => ({
      ...match,
      utcDate: new Date(kickoffMs),
      observedAt: new Date(observedAtMs),
    }),
  );
  return {
    ...input,
    matches: createChampionsLeagueKnockoutMatchProviders({
      season: input.season,
      dataCutoffMs: input.dataCutoffMs,
      observations,
      forecasts: createChampionsLeagueKnockoutForecasts(knockoutSnapshot.strengths),
    }),
  };
}
