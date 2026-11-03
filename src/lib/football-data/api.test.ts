import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFootballDataApi, FootballDataValidationError } from './api';
import { FootballDataHttpError } from './client';
import fixture from './fixtures/competition-teams.json';

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
