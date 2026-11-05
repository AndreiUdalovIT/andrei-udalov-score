import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { competitionOptions, parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:scorers --competition CODE [--season YYYY]\n' +
  '       pnpm sync:scorers --help\n\n' +
  'Syncs the complete scorer ranking.\n' +
  'Omit --season to load the current season.\n' +
  'Load the competition and teams for the requested season first.\n' +
  'An empty ranking clears saved scorers for the requested season.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: competitionOptions,
    allowPositionals: false,
  });

  if (values.help) return null;

  return parseCompetitionOptions(values);
}

export async function runScorersCommand(args: string[]) {
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
    const { syncCompetitionScorers } = await import('./scorers');
    const { competitionCode, season, rowCount } = await syncCompetitionScorers(
      options.competitionCode,
      { season: options.season },
    );
    console.log(`Synced ${rowCount} scorers for ${competitionCode} ${season}.`);
    return 0;
  } catch {
    // Import and environment errors can also contain connection details.
    console.error(
      'Scorers sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
    );
    return 1;
  }
}
