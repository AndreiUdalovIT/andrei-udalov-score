import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';

const USAGE =
  'Usage: pnpm sync:squad --team ID\n' +
  '       pnpm sync:squad --help\n\n' +
  'Syncs the current squad and team details.\n' +
  'An empty squad clears saved players for the requested team.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      team: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;

  const value = values.team?.trim();
  const teamId = Number(value);
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(teamId)) {
    throw new Error('Invalid squad sync options');
  }

  return { teamId };
}

export async function runSquadCommand(args: string[]) {
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
    const { syncTeamSquad } = await import('./squad');
    const { teamId, playerCount } = await syncTeamSquad(options.teamId);
    console.log(`Synced ${playerCount} squad players for team ${teamId}.`);
    return 0;
  } catch {
    // Import and environment errors can also contain connection details.
    console.error(
      'Squad sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and API access.',
    );
    return 1;
  }
}
