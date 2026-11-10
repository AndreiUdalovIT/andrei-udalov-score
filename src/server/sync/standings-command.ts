import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { competitionOptions, parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:standings --competition CODE [--season YYYY]\n' +
  '       pnpm sync:standings --competition CODE --season YYYY --matchday N\n' +
  '       pnpm sync:standings --competition CODE --season YYYY --through-matchday N\n' +
  '       pnpm sync:standings --help\n\n' +
  'Omit --season to load the current season.\n' +
  'Load the competition and teams for the requested season first.\n' +
  'An empty standings response clears the requested season.\n' +
  'Use --matchday with --season to append reconstructed round history.\n' +
  'Round history excludes deducted points. An empty history response fails.\n' +
  'Range mode loads rounds 1 through N for configured PL, PD, BL1, SA and FL1 seasons.\n' +
  'Completed snapshots remain saved if a later round fails.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      ...competitionOptions,
      matchday: { type: 'string' },
      'through-matchday': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;

  const options = parseCompetitionOptions(values);
  if (values.matchday !== undefined && values['through-matchday'] !== undefined) {
    throw new RangeError('choose matchday or through-matchday');
  }
  const round = values.matchday ?? values['through-matchday'];
  if (
    round !== undefined &&
    (!/^[1-9]\d*$/.test(round) ||
      !Number.isSafeInteger(Number(round)) ||
      options.season === undefined)
  ) {
    throw new RangeError(
      'round selection requires season and a positive safe integer',
    );
  }

  return {
    ...options,
    matchday: values.matchday === undefined ? undefined : Number(round),
    throughMatchday:
      values['through-matchday'] === undefined ? undefined : Number(round),
  };
}

export async function runStandingsCommand(args: string[]) {
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(args);
  } catch {
    console.error(`Invalid arguments.\n${USAGE}`);
    return 2;
  }

  if (!options) {
    console.log(USAGE);
    return 0;
  }

  try {
    // Load environment variables before importing the database client.
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', {
      info: () => undefined,
      error: () => undefined,
    });
    if (options.throughMatchday !== undefined && options.season !== undefined) {
      const { syncCompetitionStandingsHistory } =
        await import('./standings-history');
      const { competitionCode, season, snapshots } =
        await syncCompetitionStandingsHistory(options.competitionCode, {
          season: options.season,
          throughMatchday: options.throughMatchday,
        });
      console.log(
        `Captured ${snapshots.length} reconstructed standings snapshots for ${competitionCode} ${season} (matchdays 1-${options.throughMatchday}).`,
      );
      return 0;
    }
    const { syncCompetitionStandings } = await import('./standings');
    const { competitionCode, season, rowCount } = await syncCompetitionStandings(
      options.competitionCode,
      { season: options.season, matchday: options.matchday },
    );
    console.log(
      options.matchday === undefined
        ? `Synced ${rowCount} standings rows for ${competitionCode} ${season}.`
        : `Captured ${rowCount} reconstructed standings rows for ${competitionCode} ${season}, matchday ${options.matchday}.`,
    );
    return 0;
  } catch {
    // Import and environment errors can also contain connection details.
    console.error(
      'Standings sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
    );
    return 1;
  }
}
