import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:seed --competition CODE [--competition CODE ...]\n' +
  '       [--history-seasons N]\n' +
  '       pnpm sync:seed --help\n\n' +
  'Syncs the current season and up to N previous seasons from each catalog (default: 3).\n' +
  'Use 0 to sync only the current season. Current squads are included.\n' +
  'Completed datasets remain saved if a later operation fails.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      competition: { type: 'string', multiple: true },
      'history-seasons': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;
  if (!values.competition?.length) {
    throw new Error('At least one competition is required');
  }

  const historyValue = values['history-seasons'];
  const historySeasons =
    historyValue === undefined ? undefined : Number(historyValue);
  if (
    historyValue !== undefined &&
    (!/^\d+$/.test(historyValue) || !Number.isSafeInteger(historySeasons))
  ) {
    throw new RangeError('history-seasons must be a non-negative safe integer');
  }

  return {
    competitionCodes: values.competition.map(
      (competition) => parseCompetitionOptions({ competition }).competitionCode,
    ),
    historySeasons,
  };
}

export async function runSeedCommand(args: string[]) {
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

  const { competitionCodes, historySeasons } = options;
  try {
    // Load environment variables before importing the database client.
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', {
      info: () => undefined,
      error: () => undefined,
    });
    const { runSync } = await import('./run');
    const { syncSeedCompetitions } = await import('./seed');
    const { competitions, history, squadCount } = await runSync(
      'seed',
      competitionCodes,
      (requestCounter) =>
        syncSeedCompetitions(competitionCodes, { historySeasons, requestCounter }),
    );
    for (const competition of [...history, ...competitions]) {
      console.log(
        `Synced ${competition.competitionCode} ${competition.season}. ` +
          `${competition.teamCount} teams, ${competition.matchCount} matches, ` +
          `${competition.standingsCount} standings rows, ${competition.scorerCount} scorers.`,
      );
    }
    console.log(`Synced ${squadCount} unique current team squads.`);
    return 0;
  } catch (error) {
    // Import and environment errors can also contain connection details.
    console.error(
      error instanceof Error && error.name === 'SyncAlreadyRunningError'
        ? 'Another sync run is already running. Check the sync run journal.'
        : 'Seed sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
    return 1;
  }
}
