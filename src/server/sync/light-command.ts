import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:light --competition CODE [--competition CODE ...]\n' +
  '       pnpm sync:light --help\n\n' +
  'Syncs the current season with a match window of UTC today +/-7 days (inclusive).\n' +
  'Updates teams, standings and scorers; completed datasets remain saved after a failure.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      competition: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;
  if (!values.competition?.length) {
    throw new Error('At least one competition is required');
  }

  return values.competition.map(
    (competition) => parseCompetitionOptions({ competition }).competitionCode,
  );
}

export async function runLightCommand(args: string[]) {
  let competitionCodes: ReturnType<typeof parseOptions>;
  try {
    competitionCodes = parseOptions(args);
  } catch {
    console.error(`Invalid arguments.\n${USAGE}`);
    return 2;
  }

  if (!competitionCodes) {
    console.log(USAGE);
    return 0;
  }

  try {
    // Load environment variables before importing the database client.
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', {
      info: () => undefined,
      error: () => undefined,
    });
    const { runSync } = await import('./run');
    const { syncLightCompetitions } = await import('./light');
    const { dateFrom, dateTo, competitions } = await runSync(
      'light',
      competitionCodes,
      (requestCounter) =>
        syncLightCompetitions(competitionCodes, { requestCounter }),
    );
    for (const competition of competitions) {
      console.log(
        `Synced ${competition.competitionCode} ${competition.season}. ` +
          `${competition.teamCount} teams, ${competition.matchCount} matches, ` +
          `${competition.standingsCount} standings rows, ${competition.scorerCount} scorers.`,
      );
    }
    console.log(`Match window: ${dateFrom} to ${dateTo} (UTC, inclusive).`);
    return 0;
  } catch (error) {
    // Import and environment errors can also contain connection details.
    console.error(
      error instanceof Error && error.name === 'SyncAlreadyRunningError'
        ? 'Another sync run is already running. Check the sync run journal.'
        : 'Light sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
    return 1;
  }
}
