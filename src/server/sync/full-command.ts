import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

import { parseCompetitionOptions } from './command-options';

const USAGE =
  'Usage: pnpm sync:full --competition CODE [--competition CODE ...] [--season-forecasts]\n' +
  '       pnpm sync:full --help\n\n' +
  'Syncs the current season and unique team squads for selected competitions.\n' +
  'Completed datasets remain saved if a later operation fails.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      competition: { type: 'string', multiple: true },
      'season-forecasts': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;
  if (!values.competition?.length) {
    throw new Error('At least one competition is required');
  }

  return {
    competitionCodes: values.competition.map(
      (competition) => parseCompetitionOptions({ competition }).competitionCode,
    ),
    seasonForecasts: values['season-forecasts'],
  };
}

export async function runFullCommand(args: string[]) {
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

  const { competitionCodes, seasonForecasts } = options;
  try {
    // Load environment variables before importing the database client.
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', {
      info: () => undefined,
      error: () => undefined,
    });
    const { runSync } = await import('./run');
    const { syncFullCompetitions } = await import('./full');
    const { competitions, squadCount } = await runSync(
      'full',
      competitionCodes,
      (requestCounter) => syncFullCompetitions(competitionCodes, { requestCounter }),
    );
    for (const competition of competitions) {
      console.log(
        `Synced ${competition.competitionCode} ${competition.season}. ` +
          `${competition.teamCount} teams, ${competition.matchCount} matches, ` +
          `${competition.standingsCount} standings rows, ${competition.scorerCount} scorers.`,
      );
    }
    console.log(`Synced ${squadCount} unique team squads.`);
    if (seasonForecasts) {
      try {
        const { calculateSyncedSeasonForecasts } =
          await import('../forecasts/calculate-synced-season-forecasts');
        await calculateSyncedSeasonForecasts(competitions);
      } catch {
        console.warn('Season forecast calculation could not be started.');
      }
    }
    return 0;
  } catch (error) {
    // Import and environment errors can also contain connection details.
    console.error(
      error instanceof Error && error.name === 'SyncAlreadyRunningError'
        ? 'Another sync run is already running. Check the sync run journal.'
        : 'Full sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
    return 1;
  }
}
