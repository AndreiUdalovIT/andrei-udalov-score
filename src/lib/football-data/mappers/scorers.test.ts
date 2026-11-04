import { describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/scorers.json';
import { scorersResponseSchema } from '../schemas/scorers';
import { mapScorers } from './scorers';

vi.mock('server-only', () => ({}));

const league = scorersResponseSchema.parse(fixture.league);
const championsLeague = scorersResponseSchema.parse(fixture.championsLeague);

describe('scorers mapper', () => {
  it('maps player identities and preserves unknown statistics', () => {
    expect(mapScorers(league)).toEqual([
      {
        competitionId: 2021,
        season: 2026,
        playerId: 38101,
        playerName: 'Erling Haaland',
        teamId: 65,
        playedMatches: 9,
        goals: 9,
        assists: null,
        penalties: null,
      },
      {
        competitionId: 2021,
        season: 2026,
        playerId: 6486,
        playerName: 'Alexander Isak',
        teamId: 64,
        playedMatches: 8,
        goals: 6,
        assists: null,
        penalties: null,
      },
    ]);
  });

  it('maps another competition with a known penalty count', () => {
    const rows = mapScorers(championsLeague);

    expect(rows[0]).toMatchObject({
      competitionId: 2001,
      season: 2026,
      playerId: 177321,
      playerName: 'Nicolo Tresoldi',
      teamId: 851,
      playedMatches: 3,
      goals: 4,
      assists: null,
      penalties: 2,
    });
  });

  it('preserves confirmed zeroes instead of treating them as unknown', () => {
    const rows = mapScorers({
      ...league,
      scorers: league.scorers.map((scorer) => ({
        ...scorer,
        playedMatches: 0,
        goals: 0,
        assists: 0,
        penalties: 0,
      })),
    });

    expect(
      rows.map(({ playedMatches, goals, assists, penalties }) => ({
        playedMatches,
        goals,
        assists,
        penalties,
      })),
    ).toEqual([
      { playedMatches: 0, goals: 0, assists: 0, penalties: 0 },
      { playedMatches: 0, goals: 0, assists: 0, penalties: 0 },
    ]);
  });

  it('uses the starting year of a historical season', () => {
    const rows = mapScorers({
      ...league,
      season: {
        ...league.season,
        startDate: '2024-08-16',
        endDate: '2025-05-25',
      },
    });

    expect(rows.map((row) => row.season)).toEqual([2024, 2024]);
  });

  it('keeps an empty scorer list empty', () => {
    expect(mapScorers({ ...league, scorers: [] })).toEqual([]);
  });

  it('rejects a repeated player in the same competition season', () => {
    expect(() =>
      mapScorers({
        ...league,
        scorers: [...league.scorers, ...league.scorers],
      }),
    ).toThrow('Scorers response contains a duplicate player');
  });
});
