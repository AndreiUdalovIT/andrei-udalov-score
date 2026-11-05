import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

const USAGE =
  'Usage: pnpm sync:standings --competition CODE [--season YYYY]\n' +
  '       pnpm sync:standings --help\n\n' +
  'Omit --season to load the current season.\n' +
  'Load the competition and teams for the requested season first.\n' +
  'An empty standings response clears the requested season.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      competition: { type: 'string' },
      season: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;

  const competitionCode = values.competition?.trim().toUpperCase();
  if (
    !competitionCode ||
    !/^[A-Z][A-Z0-9]*$/.test(competitionCode) ||
    (values.season !== undefined && !/^[1-9]\d{3}$/.test(values.season))
  ) {
    throw new Error('Invalid standings sync options');
  }

  return {
    competitionCode,
    season: values.season === undefined ? undefined : Number(values.season),
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
    const { syncCompetitionStandings } = await import('./standings');
    const { competitionCode, season, rowCount } = await syncCompetitionStandings(
      options.competitionCode,
      { season: options.season },
    );
    console.log(
      `Synced ${rowCount} standings rows for ${competitionCode} ${season}.`,
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
