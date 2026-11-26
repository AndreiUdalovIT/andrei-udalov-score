import 'server-only';

import { randomBytes } from 'node:crypto';

import {
  siteCompetitionCodes,
  type SiteCompetitionCode,
} from '@/lib/config/competitions';
import type { RandomSeed } from '@/lib/model/seeded-random';

import { calculateAndStoreSeasonForecast } from './calculate-and-store';
import { calculateChampionsLeagueForecast } from './calculate-champions-league-forecast';
import { loadLeagueForecastInput } from './load-league-input';

function randomSeed(): RandomSeed {
  const bytes = randomBytes(16);
  const seed = [
    bytes.readUInt32LE(0),
    bytes.readUInt32LE(4),
    bytes.readUInt32LE(8),
    bytes.readUInt32LE(12),
  ] as const;
  return seed.every((word) => word === 0) ? [1, 0, 0, 0] : seed;
}

async function calculateForecast(
  competitionCode: SiteCompetitionCode,
  season: number,
  before: Date,
) {
  const options = { before, seed: randomSeed() };
  if (competitionCode === 'CL')
    return calculateChampionsLeagueForecast(season, options);

  const prepared = await loadLeagueForecastInput(competitionCode, season, options);
  if (prepared.status !== 'ready') return prepared;
  return calculateAndStoreSeasonForecast({
    kind: 'league-table',
    input: prepared.input,
  });
}

/** Calculate from the data left by a completed full sync, using one cutoff per batch. */
export async function calculateSyncedSeasonForecasts(
  competitions: readonly { competitionCode: string; season: number }[],
): Promise<void> {
  const before = new Date();
  for (const { competitionCode, season } of competitions) {
    const code = siteCompetitionCodes.find(
      (candidate) => candidate === competitionCode,
    );
    if (code === undefined) continue;

    const label = `${code} ${season}`;
    try {
      const result = await calculateForecast(code, season, before);
      if (result.status === 'stored') {
        console.log(`Stored season forecast for ${label} (ID ${result.id}).`);
      } else {
        const diagnostic = 'detail' in result ? result.detail : result;
        const reason = 'reason' in diagnostic ? diagnostic.reason : result.status;
        const stage = 'stage' in diagnostic ? ` (${diagnostic.stage})` : '';
        console.log(`Season forecast skipped for ${label}: ${reason}${stage}.`);
      }
    } catch {
      // Driver errors can include connection details or query parameters.
      console.warn(`Season forecast failed for ${label}.`);
    }
  }
}
