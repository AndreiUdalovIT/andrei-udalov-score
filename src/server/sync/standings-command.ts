import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { competitionOptions, parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:standings --competition CODE [--season YYYY]\n' +
  '       pnpm sync:standings --competition CODE --season YYYY --matchday N\n' +
  '       pnpm sync:standings --help\n\n' +
  'Omit --season to load the current season.\n' +
  'Load the competition and teams for the requested season first.\n' +
  'An empty standings response clears the requested season.\n' +
  'Use --matchday with --season to append reconstructed round history.\n' +
  'Round history excludes deducted points. An empty history response fails.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { ...competitionOptions, matchday: { type: 'string' } },
    allowPositionals: false,
  });

  if (values.help) return null;

  const options = parseCompetitionOptions(values);
  const matchday =
    values.matchday === undefined ? undefined : Number(values.matchday);
  if (
    values.matchday !== undefined &&
    (!/^[1-9]\d*$/.test(values.matchday) ||
      !Number.isSafeInteger(matchday) ||
      options.season === undefined)
  ) {
    throw new RangeError('matchday requires season and a positive safe integer');
  }

  return { ...options, matchday };
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
