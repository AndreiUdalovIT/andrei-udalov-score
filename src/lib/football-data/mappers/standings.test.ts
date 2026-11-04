import { describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/standings.json';
import { standingsResponseSchema } from '../schemas/standings';
import { mapStandings } from './standings';

vi.mock('server-only', () => ({}));

const league = standingsResponseSchema.parse(fixture.league);
const championsLeague = standingsResponseSchema.parse(fixture.championsLeague);

describe('standings mapper', () => {
  it('maps the official league rows without renumbering positions', () => {
    expect(mapStandings(league)).toEqual([
      {
        competitionId: 2021,
        season: 2026,
        teamId: 57,
        position: 1,
        playedGames: 9,
        won: 8,
        draw: 0,
        lost: 1,
        points: 24,
        goalsFor: 14,
        goalsAgainst: 5,
      },
      {
        competitionId: 2021,
        season: 2026,
        teamId: 71,
        position: 20,
        playedGames: 9,
        won: 1,
        draw: 2,
        lost: 6,
        points: 5,
        goalsFor: 7,
        goalsAgainst: 17,
      },
    ]);
  });

  it('maps the Champions League table with its full ranking positions', () => {
    const rows = mapStandings(championsLeague);

    expect(
      rows.map(({ competitionId, season, teamId, position }) => ({
        competitionId,
        season,
        teamId,
        position,
      })),
    ).toEqual([
      { competitionId: 2001, season: 2026, teamId: 524, position: 1 },
      { competitionId: 2001, season: 2026, teamId: 7509, position: 36 },
    ]);
  });

  it('selects TOTAL even when HOME and AWAY tables surround it', () => {
    const rows = mapStandings({
      ...league,
      standings: league.standings.flatMap((standing) => [
        {
          ...standing,
          type: 'HOME' as const,
          table: standing.table.map((row) => ({ ...row, points: 100 })),
        },
        standing,
        {
          ...standing,
          type: 'AWAY' as const,
          table: standing.table.map((row) => ({ ...row, points: 200 })),
        },
      ]),
    });

    expect(rows.map(({ teamId, points }) => ({ teamId, points }))).toEqual([
      { teamId: 57, points: 24 },
      { teamId: 71, points: 5 },
    ]);
  });

  it('preserves negative official points instead of deriving them from results', () => {
    const rows = mapStandings({
      ...league,
      standings: league.standings.map((standing) => ({
        ...standing,
        table: standing.table.map((row) => ({ ...row, points: -3 })),
      })),
    });

    expect(rows.map((row) => row.points)).toEqual([-3, -3]);
  });

  it('maps all TOTAL groups when their team IDs are distinct', () => {
    const rows = mapStandings({
      ...league,
      standings: league.standings.flatMap((standing) =>
        standing.table.map((row, index) => ({
          ...standing,
          group: `GROUP_${index + 1}`,
          table: [row],
        })),
      ),
    });

    expect(rows.map((row) => row.teamId)).toEqual([57, 71]);
  });

  it('rejects team IDs repeated across TOTAL tables', () => {
    expect(() =>
      mapStandings({
        ...league,
        standings: [...league.standings, ...league.standings],
      }),
    ).toThrow('Standings response contains a duplicate team in TOTAL tables');
  });

  it('rejects a nonempty response without a TOTAL table', () => {
    expect(() =>
      mapStandings({
        ...league,
        standings: league.standings.map((standing) => ({
          ...standing,
          type: 'HOME',
        })),
      }),
    ).toThrow('Standings response has no TOTAL table');
  });

  it('accepts an empty standings list', () => {
    expect(mapStandings({ ...league, standings: [] })).toEqual([]);
  });

  it('accepts a TOTAL table without rows', () => {
    expect(
      mapStandings({
        ...league,
        standings: league.standings.map((standing) => ({
          ...standing,
          table: [],
        })),
      }),
    ).toEqual([]);
  });
});
