import 'server-only';

import type { ZodError } from 'zod';

import { createFootballDataClient, type ClientOptions } from './client';
import { teamsResponseSchema, type ApiTeamsResponse } from './schemas/teams';

type CompetitionTeamsOptions = {
  season?: number;
  signal?: AbortSignal;
};

export class FootballDataValidationError extends Error {
  readonly issues;

  constructor(
    readonly resource: string,
    error: ZodError,
  ) {
    super(`football-data returned an invalid response for ${resource}`);
    this.name = 'FootballDataValidationError';
    // Keep field diagnostics without carrying response values or error messages.
    this.issues = error.issues.map(({ code, path }) => ({ code, path }));
  }
}

export function createFootballDataApi(options: ClientOptions = {}) {
  const client = createFootballDataClient(options);

  return {
    async getCompetitionTeams(
      competitionCode: string,
      { season, signal }: CompetitionTeamsOptions = {},
    ): Promise<ApiTeamsResponse> {
      const code = competitionCode.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]*$/.test(code)) {
        throw new RangeError(
          'competitionCode must be a football-data competition code',
        );
      }
      if (
        season !== undefined &&
        (!Number.isInteger(season) || season < 1000 || season > 9999)
      ) {
        throw new RangeError('season must be a four-digit starting year');
      }

      const resource = `competitions/${code}/teams`;
      const data = await client.get(resource, {
        params: season === undefined ? undefined : { season },
        signal,
      });
      const schema = teamsResponseSchema
        .refine((response) => response.competition.code === code, {
          path: ['competition', 'code'],
          message: 'Unexpected competition',
        })
        .refine(
          (response) =>
            season === undefined ||
            Number(response.season.startDate.slice(0, 4)) === season,
          { path: ['season', 'startDate'], message: 'Unexpected season' },
        );
      const result = schema.safeParse(data);
      if (!result.success) {
        throw new FootballDataValidationError(resource, result.error);
      }
      return result.data;
    },
  };
}
