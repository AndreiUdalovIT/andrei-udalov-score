import 'server-only';

import { getCompetitionSeasonConfig } from '@/lib/config/competition-seasons';
import type { ClientOptions } from '@/lib/football-data/client';

import { syncCompetitionStandings } from './standings';

type StandingsHistorySyncOptions = {
  season: number;
  throughMatchday: number;
  signal?: AbortSignal;
  requestCounter?: ClientOptions['requestCounter'];
};

const historyCompetitionCodes = ['PL', 'PD', 'BL1', 'SA', 'FL1'] as const;

export async function syncCompetitionStandingsHistory(
  competitionCode: string,
  { season, throughMatchday, signal, requestCounter }: StandingsHistorySyncOptions,
) {
  const code = historyCompetitionCodes.find(
    (code) => code === competitionCode.trim().toUpperCase(),
  );
  const config =
    code === undefined ? undefined : getCompetitionSeasonConfig(code, season);
  if (code === undefined || config === undefined) {
    throw new RangeError('round history requires a configured domestic season');
  }
  if (
    !Number.isSafeInteger(throughMatchday) ||
    throughMatchday < 1 ||
    throughMatchday > config.matchdays
  ) {
    throw new RangeError('throughMatchday is outside the configured season');
  }

  const options = {
    season,
    expectedTable: { teamCount: config.teamCount, stage: config.mainStage },
    signal,
    requestCounter,
  };
  const snapshots = [];
  for (let matchday = 1; matchday <= throughMatchday; matchday++) {
    const result = await syncCompetitionStandings(code, { ...options, matchday });
    snapshots.push({ matchday, rowCount: result.rowCount });
  }

  return { competitionCode: code, season, snapshots };
}
