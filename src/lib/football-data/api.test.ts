import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatchStatus } from '@/lib/types/football';

import { createFootballDataApi, FootballDataValidationError } from './api';
import { FootballDataHttpError } from './client';
import fixture from './fixtures/competition-teams.json';
import matchFixture from './fixtures/matches.json';
import scorersFixture from './fixtures/scorers.json';
import standingsFixture from './fixtures/standings.json';

vi.mock('server-only', () => ({}));

const TOKEN = 'test-token';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('getCompetitionTeams', () => {
  it('loads the current season and returns validated team data', async () => {
    fetchMock.mockResolvedValue(Response.json(fixture));
    const api = createFootballDataApi({ token: TOKEN });

    const result = await api.getCompetitionTeams('PL');

    expect(result.competition.code).toBe('PL');
    expect(result.teams).toEqual(fixture.teams);
    expect(result.competition).not.toHaveProperty('type');
    expect(result.season).not.toHaveProperty('winner');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.football-data.org/v4/competitions/PL/teams'),
      expect.objectContaining({
        headers: { 'X-Auth-Token': TOKEN, Accept: 'application/json' },
      }),
    );
  });

  it('normalizes the competition code and sends the season filter', async () => {
    fetchMock.mockResolvedValue(Response.json(fixture));
    const api = createFootballDataApi({ token: TOKEN });

    await api.getCompetitionTeams(' pl ', { season: 2026 });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.football-data.org/v4/competitions/PL/teams?season=2026'),
      expect.any(Object),
    );
  });

  it('preserves an empty team list', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...fixture, teams: [] }));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionTeams('PL')).resolves.toMatchObject({
      teams: [],
    });
  });

  it('reports the invalid field without exposing response values', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...fixture,
        teams: fixture.teams.map((team) => ({
          ...team,
          id: 'Sensitive upstream value',
        })),
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    const error: unknown = await api
      .getCompetitionTeams('PL')
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(FootballDataValidationError);
    if (!(error instanceof FootballDataValidationError)) {
      throw new Error('Expected a validation error');
    }
    expect(error.resource).toBe('competitions/PL/teams');
    expect(error.message).toBe(
      'football-data returned an invalid response for competitions/PL/teams',
    );
    expect(error.issues).toEqual([
      { code: 'invalid_type', path: ['teams', 0, 'id'] },
    ]);
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('Sensitive upstream value');
  });

  it('rejects a response belonging to a different competition', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...fixture,
        competition: { ...fixture.competition, code: 'PD' },
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionTeams('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['competition', 'code'] }],
    });
  });

  it('rejects a response belonging to a different season', async () => {
    fetchMock.mockResolvedValue(Response.json(fixture));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionTeams('PL', { season: 2025 }),
    ).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['season', 'startDate'] }],
    });
  });

  it.each(['', ' ', '../matches', 'PL/teams', 'PL?season=2025', 'PL#fragment'])(
    'rejects an invalid competition code %j before making a request',
    async (code) => {
      const api = createFootballDataApi({ token: TOKEN });

      await expect(api.getCompetitionTeams(code)).rejects.toThrow(RangeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([0, 999, 10_000, 2026.5, NaN])(
    'rejects an invalid season %s before making a request',
    async (season) => {
      const api = createFootballDataApi({ token: TOKEN });

      await expect(api.getCompetitionTeams('PL', { season })).rejects.toThrow(
        RangeError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('forwards cancellation to the HTTP client', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionTeams('PL', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves HTTP errors without wrapping them as validation errors', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const api = createFootballDataApi({ token: TOKEN });
    const request = api.getCompetitionTeams('PL');

    await expect(request).rejects.toBeInstanceOf(FootballDataHttpError);
    await expect(request).rejects.toMatchObject({ status: 403 });
  });
});

describe('getCompetitionMatches', () => {
  const response = {
    competition: matchFixture.upcoming.competition,
    matches: [matchFixture.upcoming],
  };

  it('loads and validates matches for the current season', async () => {
    fetchMock.mockResolvedValue(Response.json(response));
    const api = createFootballDataApi({ token: TOKEN });

    const result = await api.getCompetitionMatches('PL');

    expect(result.matches[0]?.id).toBe(matchFixture.upcoming.id);
    expect(result.matches[0]?.score.fullTime).toEqual({ home: null, away: null });
    expect(result.matches[0]?.competition).not.toHaveProperty('type');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.football-data.org/v4/competitions/PL/matches'),
      expect.any(Object),
    );
  });

  it('normalizes the code and sends filters for a single calendar day', async () => {
    fetchMock.mockResolvedValue(Response.json(response));
    const api = createFootballDataApi({ token: TOKEN });

    await api.getCompetitionMatches(' pl ', {
      season: 2026,
      status: 'TIMED',
      dateFrom: '2026-11-06',
      dateTo: '2026-11-06',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.football-data.org/v4/competitions/PL/matches?season=2026&status=TIMED&dateFrom=2026-11-06&dateTo=2026-11-06',
      ),
      expect.any(Object),
    );
  });

  it('preserves regulation and shootout scores in historical matches', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        competition: matchFixture.penalties.competition,
        matches: [matchFixture.penalties],
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    const result = await api.getCompetitionMatches('CL', {
      season: 2025,
      status: 'FINISHED',
    });

    expect(result.matches[0]?.score.regularTime).toEqual({ home: 1, away: 1 });
    expect(result.matches[0]?.score.penalties).toEqual({ home: 4, away: 3 });
  });

  it('accepts an empty match list', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...response, matches: [] }));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL')).resolves.toEqual({ matches: [] });
  });

  it('checks the competition even when the list is empty', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        competition: { ...response.competition, code: 'PD' },
        matches: [],
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['competition', 'code'] }],
    });
  });

  it('rejects a match belonging to another competition', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...response,
        matches: [matchFixture.penalties],
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL')).rejects.toMatchObject({
      issues: [{ code: 'custom', path: ['matches', 0, 'competition', 'code'] }],
    });
  });

  it('rejects a match belonging to another season', async () => {
    fetchMock.mockResolvedValue(Response.json(response));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionMatches('PL', { season: 2025 }),
    ).rejects.toMatchObject({
      issues: [{ code: 'custom', path: ['matches', 0, 'season', 'startDate'] }],
    });
  });

  it('rejects a match that does not match the status filter', async () => {
    fetchMock.mockResolvedValue(Response.json(response));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionMatches('PL', { status: 'FINISHED' }),
    ).rejects.toMatchObject({
      issues: [{ code: 'custom', path: ['matches', 0, 'status'] }],
    });
  });

  it.each([
    { dateFrom: '2026-11-04', dateTo: '2026-11-05' },
    { dateFrom: '2026-11-07', dateTo: '2026-11-08' },
  ])('rejects a match outside $dateFrom / $dateTo', async (range) => {
    fetchMock.mockResolvedValue(Response.json(response));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL', range)).rejects.toMatchObject({
      issues: [{ code: 'custom', path: ['matches', 0, 'utcDate'] }],
    });
  });

  it('reports an unknown upstream status at its array position', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...response,
        matches: [{ ...matchFixture.upcoming, status: 'FUTURE_STATUS' }],
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'invalid_value', path: ['matches', 0, 'status'] }],
    });
  });

  it('rejects an invalid competition code before making a request', async () => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('../matches')).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing dateTo', options: { dateFrom: '2026-11-06' } },
    { label: 'missing dateFrom', options: { dateTo: '2026-11-06' } },
    {
      label: 'invalid dateFrom',
      options: { dateFrom: '2026-02-30', dateTo: '2026-11-06' },
    },
    {
      label: 'invalid dateTo',
      options: { dateFrom: '2026-11-06', dateTo: 'not-a-date' },
    },
    {
      label: 'reversed range',
      options: { dateFrom: '2026-11-07', dateTo: '2026-11-06' },
    },
    { label: 'invalid status', options: { status: 'FUTURE_STATUS' as MatchStatus } },
    { label: 'invalid season', options: { season: 0 } },
  ] as const)('rejects $label before making a request', async ({ options }) => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL', options)).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the HTTP client', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionMatches('PL', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionMatches('PL')).rejects.toBeInstanceOf(
      FootballDataHttpError,
    );
  });
});

describe('getCompetitionStandings', () => {
  it.each(Object.entries(standingsFixture))(
    'loads and validates the %s standings',
    async (_name, data) => {
      fetchMock.mockResolvedValue(Response.json(data));
      const api = createFootballDataApi({ token: TOKEN });

      const result = await api.getCompetitionStandings(data.competition.code);

      expect(result.competition.code).toBe(data.competition.code);
      expect(result.standings[0]?.table.map((row) => row.position)).toEqual(
        data.standings[0]?.table.map((row) => row.position),
      );
      expect(result.standings[0]?.table[1]?.team.name).toBe(
        data.standings[0]?.table[1]?.team.name,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        new URL(
          `https://api.football-data.org/v4/competitions/${data.competition.code}/standings`,
        ),
        expect.any(Object),
      );
    },
  );

  it('normalizes the competition code and sends the season filter', async () => {
    fetchMock.mockResolvedValue(Response.json(standingsFixture.league));
    const api = createFootballDataApi({ token: TOKEN });

    await api.getCompetitionStandings(' pl ', { season: 2026 });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.football-data.org/v4/competitions/PL/standings?season=2026',
      ),
      expect.any(Object),
    );
  });

  it('returns every provided table type for the mapper to select', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...standingsFixture.league,
        standings: standingsFixture.league.standings.flatMap((standing) => [
          standing,
          { ...standing, type: 'HOME' },
          { ...standing, type: 'AWAY' },
        ]),
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    const result = await api.getCompetitionStandings('PL');

    expect(result.standings.map((standing) => standing.type)).toEqual([
      'TOTAL',
      'HOME',
      'AWAY',
    ]);
  });

  it('accepts an empty standings list', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...standingsFixture.league, standings: [] }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('PL')).resolves.toMatchObject({
      standings: [],
    });
  });

  it('rejects another competition even when the list is empty', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...standingsFixture.championsLeague, standings: [] }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['competition', 'code'] }],
    });
  });

  it('rejects a response belonging to another season', async () => {
    fetchMock.mockResolvedValue(Response.json(standingsFixture.league));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionStandings('PL', { season: 2025 }),
    ).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['season', 'startDate'] }],
    });
  });

  it('reports invalid points at the exact table row', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...standingsFixture.league,
        standings: standingsFixture.league.standings.map((standing) => ({
          ...standing,
          table: [{ ...standing.table[0], points: null }],
        })),
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [
        { code: 'invalid_type', path: ['standings', 0, 'table', 0, 'points'] },
      ],
    });
  });

  it('rejects an invalid competition code before making a request', async () => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('../standings')).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid season before making a request', async () => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('PL', { season: NaN })).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the HTTP client', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionStandings('PL', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionStandings('PL')).rejects.toBeInstanceOf(
      FootballDataHttpError,
    );
  });
});

describe('getCompetitionScorers', () => {
  it.each(Object.entries(scorersFixture))(
    'loads and validates the %s scorers',
    async (_name, data) => {
      fetchMock.mockResolvedValue(Response.json(data));
      const api = createFootballDataApi({ token: TOKEN });

      const result = await api.getCompetitionScorers(data.competition.code);

      expect(result.scorers).toEqual(data.scorers);
      expect(result.competition).not.toHaveProperty('type');
      expect(fetchMock).toHaveBeenCalledWith(
        new URL(
          `https://api.football-data.org/v4/competitions/${data.competition.code}/scorers`,
        ),
        expect.any(Object),
      );
    },
  );

  it('normalizes the code and sends the season and limit filters', async () => {
    fetchMock.mockResolvedValue(Response.json(scorersFixture.league));
    const api = createFootballDataApi({ token: TOKEN });

    await api.getCompetitionScorers(' pl ', { season: 2026, limit: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.football-data.org/v4/competitions/PL/scorers?season=2026&limit=20',
      ),
      expect.any(Object),
    );
  });

  it.each([1, 501])('sends limit %s without a season filter', async (limit) => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...scorersFixture.league,
        scorers: scorersFixture.league.scorers.slice(0, limit),
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await api.getCompetitionScorers('PL', { limit });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        `https://api.football-data.org/v4/competitions/PL/scorers?limit=${limit}`,
      ),
      expect.any(Object),
    );
  });

  it('preserves unknown statistics and confirmed zeros', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...scorersFixture.league,
        scorers: scorersFixture.league.scorers.map((scorer, index) =>
          index === 0 ? scorer : { ...scorer, assists: 0, penalties: 0 },
        ),
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    const result = await api.getCompetitionScorers('PL');

    expect(result.scorers[0]).toMatchObject({ assists: null, penalties: null });
    expect(result.scorers[1]).toMatchObject({ assists: 0, penalties: 0 });
  });

  it('accepts an empty scorers list', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...scorersFixture.league, scorers: [] }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('PL')).resolves.toMatchObject({
      scorers: [],
    });
  });

  it('rejects another competition even when the list is empty', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...scorersFixture.championsLeague, scorers: [] }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['competition', 'code'] }],
    });
  });

  it('rejects another season even when the list is empty', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...scorersFixture.league, scorers: [] }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionScorers('PL', { season: 2025 }),
    ).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'custom', path: ['season', 'startDate'] }],
    });
  });

  it('reports invalid goals at the exact scorer position', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...scorersFixture.league,
        scorers: [{ ...scorersFixture.league.scorers[0], goals: null }],
      }),
    );
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('PL')).rejects.toMatchObject({
      name: 'FootballDataValidationError',
      issues: [{ code: 'invalid_type', path: ['scorers', 0, 'goals'] }],
    });
  });

  it('rejects an invalid competition code before making a request', async () => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('../scorers')).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid season before making a request', async () => {
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('PL', { season: NaN })).rejects.toThrow(
      RangeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid limit %s before making a request',
    async (limit) => {
      const api = createFootballDataApi({ token: TOKEN });

      await expect(api.getCompetitionScorers('PL', { limit })).rejects.toThrow(
        RangeError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('forwards cancellation to the HTTP client', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = createFootballDataApi({ token: TOKEN });

    await expect(
      api.getCompetitionScorers('PL', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const api = createFootballDataApi({ token: TOKEN });

    await expect(api.getCompetitionScorers('PL')).rejects.toBeInstanceOf(
      FootballDataHttpError,
    );
  });
});
