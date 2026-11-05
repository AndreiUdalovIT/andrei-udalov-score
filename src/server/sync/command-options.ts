import 'server-only';

export const competitionOptions = {
  competition: { type: 'string' },
  season: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

export function parseCompetitionOptions(values: {
  competition?: string;
  season?: string;
}) {
  const competitionCode = values.competition?.trim().toUpperCase();
  if (
    !competitionCode ||
    !/^[A-Z][A-Z0-9]*$/.test(competitionCode) ||
    (values.season !== undefined && !/^[1-9]\d{3}$/.test(values.season))
  ) {
    throw new Error('Invalid competition sync options');
  }

  return {
    competitionCode,
    season: values.season === undefined ? undefined : Number(values.season),
  };
}
