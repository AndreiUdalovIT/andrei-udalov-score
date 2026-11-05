import 'server-only';

import { parseArgs } from 'node:util';

import { loadEnvConfig } from '@next/env';
import { z } from 'zod';

import { MATCH_STATUSES } from '@/lib/types/football';

const dateSchema = z.iso.date();
const statusSchema = z.enum(MATCH_STATUSES).optional();

const USAGE =
  'Usage: pnpm sync:matches --competition CODE [--season YYYY]\n' +
  '       [--date-from YYYY-MM-DD --date-to YYYY-MM-DD] [--status STATUS]\n' +
  '       pnpm sync:matches --help\n\n' +
  'Without filters, syncs the current season. Date bounds are inclusive (UTC).\n' +
  'Load the competition and teams for the requested season first.';

function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      competition: { type: 'string' },
      season: { type: 'string' },
      'date-from': { type: 'string' },
      'date-to': { type: 'string' },
      status: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) return null;

  const competitionCode = values.competition?.trim().toUpperCase();
  const status = statusSchema.safeParse(values.status?.trim().toUpperCase());
  if (
    !competitionCode ||
    !/^[A-Z][A-Z0-9]*$/.test(competitionCode) ||
    (values.season !== undefined && !/^[1-9]\d{3}$/.test(values.season)) ||
    !status.success
  ) {
    throw new Error('Invalid match sync options');
  }

  const dateFrom = values['date-from'];
  const dateTo = values['date-to'];
  if ((dateFrom === undefined) !== (dateTo === undefined)) {
    throw new Error('Date bounds must be provided together');
  }
  if (dateFrom !== undefined && dateTo !== undefined) {
    if (
      !dateSchema.safeParse(dateFrom).success ||
      !dateSchema.safeParse(dateTo).success ||
      dateFrom > dateTo
    ) {
      throw new Error('Invalid date range');
    }
  }

  return {
    competitionCode,
    season: values.season === undefined ? undefined : Number(values.season),
    status: status.data,
    dateFrom,
    dateTo,
  };
}

export async function runMatchesCommand(args: string[]) {
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
    const { syncCompetitionMatches } = await import('./matches');
    const { competitionCode, ...filters } = options;
    const { matchCount } = await syncCompetitionMatches(competitionCode, filters);
    console.log(`Processed ${matchCount} matches for ${competitionCode}.`);
    return 0;
  } catch {
    // Import and environment errors can also contain connection details.
    console.error(
      'Match sync failed. Check DATABASE_URL, FOOTBALL_DATA_TOKEN and saved teams.',
    );
    return 1;
  }
}
