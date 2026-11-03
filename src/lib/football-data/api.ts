import 'server-only';

import { z, type ZodError } from 'zod';

import { MATCH_STATUSES, type MatchStatus } from '@/lib/types/football';

import { createFootballDataClient, type ClientOptions } from './client';
import {
  matchSchema,
  matchesResponseSchema,
  type ApiMatchesResponse,
} from './schemas/matches';
import { scorersResponseSchema, type ApiScorersResponse } from './schemas/scorers';
import { competitionSchema } from './schemas/shared';
import {
  standingsResponseSchema,
  type ApiStandingsResponse,
} from './schemas/standings';
import { teamsResponseSchema, type ApiTeamsResponse } from './schemas/teams';

const dateSchema = z.iso.date();

type CompetitionOptions = {
  season?: number;
  signal?: AbortSignal;
};

type CompetitionMatchesOptions = CompetitionOptions & {
  status?: MatchStatus;
  dateFrom?: string;
  dateTo?: string;
};

type CompetitionScorersOptions = CompetitionOptions & {
  limit?: number;
};

function normalizeCompetitionCode(competitionCode: string) {
  const code = competitionCode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(code)) {
    throw new RangeError('competitionCode must be a football-data competition code');
  }
  return code;
}

function validateSeason(season?: number) {
  if (
    season !== undefined &&
    (!Number.isInteger(season) || season < 1000 || season > 9999)
  ) {
    throw new RangeError('season must be a four-digit starting year');
  }
}

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
      { season, signal }: CompetitionOptions = {},
    ): Promise<ApiTeamsResponse> {
      const code = normalizeCompetitionCode(competitionCode);
      validateSeason(season);

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

    async getCompetitionMatches(
      competitionCode: string,
      { season, status, dateFrom, dateTo, signal }: CompetitionMatchesOptions = {},
    ): Promise<ApiMatchesResponse> {
      const code = normalizeCompetitionCode(competitionCode);
      validateSeason(season);
      if (status !== undefined && !MATCH_STATUSES.includes(status)) {
        throw new RangeError(
          'status must be a supported football-data match status',
        );
      }
      if ((dateFrom === undefined) !== (dateTo === undefined)) {
        throw new RangeError('dateFrom and dateTo must be provided together');
      }
      if (dateFrom !== undefined && dateTo !== undefined) {
        if (
          !dateSchema.safeParse(dateFrom).success ||
          !dateSchema.safeParse(dateTo).success
        ) {
          throw new RangeError('dateFrom and dateTo must use YYYY-MM-DD');
        }
        if (dateFrom > dateTo) {
          throw new RangeError('dateFrom must not be after dateTo');
        }
      }

      const params: Record<string, string | number> = {};
      if (season !== undefined) params.season = season;
      if (status !== undefined) params.status = status;
      if (dateFrom !== undefined && dateTo !== undefined) {
        params.dateFrom = dateFrom;
        params.dateTo = dateTo;
      }

      const resource = `competitions/${code}/matches`;
      const data = await client.get(resource, { params, signal });
      const schema = matchesResponseSchema.extend({
        competition: competitionSchema.refine(
          (competition) => competition.code === code,
          { path: ['code'], message: 'Unexpected competition' },
        ),
        matches: z.array(
          matchSchema
            .refine((match) => match.competition.code === code, {
              path: ['competition', 'code'],
              message: 'Unexpected competition',
            })
            .refine(
              (match) =>
                season === undefined ||
                Number(match.season.startDate.slice(0, 4)) === season,
              { path: ['season', 'startDate'], message: 'Unexpected season' },
            )
            .refine((match) => status === undefined || match.status === status, {
              path: ['status'],
              message: 'Unexpected status',
            })
            .refine(
              (match) => {
                if (dateFrom === undefined || dateTo === undefined) return true;
                const date = match.utcDate.slice(0, 10);
                return date >= dateFrom && date <= dateTo;
              },
              {
                path: ['utcDate'],
                message: 'Match outside the requested date range',
              },
            ),
        ),
      });
      const result = schema.safeParse(data);
      if (!result.success) {
        throw new FootballDataValidationError(resource, result.error);
      }
      return { matches: result.data.matches };
    },

    async getCompetitionStandings(
      competitionCode: string,
      { season, signal }: CompetitionOptions = {},
    ): Promise<ApiStandingsResponse> {
      const code = normalizeCompetitionCode(competitionCode);
      validateSeason(season);

      const resource = `competitions/${code}/standings`;
      const data = await client.get(resource, {
        params: season === undefined ? undefined : { season },
        signal,
      });
      const schema = standingsResponseSchema
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

    async getCompetitionScorers(
      competitionCode: string,
      { season, limit, signal }: CompetitionScorersOptions = {},
    ): Promise<ApiScorersResponse> {
      const code = normalizeCompetitionCode(competitionCode);
      validateSeason(season);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new RangeError('limit must be a positive safe integer');
      }

      const params: Record<string, string | number> = {};
      if (season !== undefined) params.season = season;
      if (limit !== undefined) params.limit = limit;

      const resource = `competitions/${code}/scorers`;
      const data = await client.get(resource, { params, signal });
      const schema = scorersResponseSchema
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
