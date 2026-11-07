import { afterEach, expect, it, vi } from 'vitest';

import teamsFixture from '@/lib/football-data/fixtures/competition-teams.json';
import matchesFixture from '@/lib/football-data/fixtures/matches.json';
import scorersFixture from '@/lib/football-data/fixtures/scorers.json';
import squadFixture from '@/lib/football-data/fixtures/squad.json';
import standingsFixture from '@/lib/football-data/fixtures/standings.json';

import { syncFullCompetitions } from './full';

vi.mock('server-only', () => ({}));
vi.mock('../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const schema = await import('../db/schema');
  const database = drizzle.mock({ schema, casing: 'snake_case' });
  Object.defineProperty(database, 'batch', {
    value: async () => undefined,
  });
  return { db: database };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('counts HTTP attempts across every full sync dataset, including retries', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
  });
  vi.stubEnv('FOOTBALL_DATA_TOKEN', 'full-sync-request-count');
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(teamsFixture))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        competition: matchesFixture.upcoming.competition,
        matches: [matchesFixture.upcoming],
      }),
    )
    .mockResolvedValueOnce(Response.json(standingsFixture.league))
    .mockResolvedValueOnce(Response.json(scorersFixture.league))
    .mockResolvedValueOnce(Response.json(squadFixture.arsenal))
    .mockRejectedValue(new Error('Unexpected request'));
  vi.stubGlobal('fetch', fetchMock);
  const requestCounter = { count: 0 };

  const result = syncFullCompetitions(['PL'], { requestCounter });
  await Promise.all([
    expect(result).resolves.toMatchObject({ squadCount: 1 }),
    vi.runAllTimersAsync(),
  ]);

  expect(requestCounter.count).toBe(6);
  expect(
    fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual([
    '/v4/competitions/PL/teams',
    '/v4/competitions/PL/matches',
    '/v4/competitions/PL/matches',
    '/v4/competitions/PL/standings',
    '/v4/competitions/PL/scorers',
    '/v4/teams/57',
  ]);
});
