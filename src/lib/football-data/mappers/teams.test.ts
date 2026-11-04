import { describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/competition-teams.json';
import { teamsResponseSchema } from '../schemas/teams';
import { mapCompetitionTeams, mapTeam } from './teams';

vi.mock('server-only', () => ({}));

const response = teamsResponseSchema.parse(fixture);
const team = response.teams[0];
if (!team) throw new Error('Missing team fixture');

describe('competition and team mappers', () => {
  it('maps a current competition, its teams and their seasonal membership', () => {
    const result = mapCompetitionTeams(response, { isCurrentSeason: true });

    expect(result.competition).toEqual({
      id: 2021,
      code: 'PL',
      name: 'Premier League',
      emblem: 'https://crests.football-data.org/PL.png',
      currentMatchday: 9,
    });
    expect(result.teams).toEqual(response.teams);
    expect(result.teamCompetitions).toEqual([
      { competitionId: 2021, season: 2026, teamId: 57 },
    ]);
  });

  it('maps a historical season without copying its matchday', () => {
    const result = mapCompetitionTeams({
      ...response,
      season: {
        ...response.season,
        startDate: '2024-08-16',
        endDate: '2025-05-25',
        currentMatchday: 38,
      },
    });

    expect(result.competition).not.toHaveProperty('currentMatchday');
    expect(result.teamCompetitions).toEqual([
      { competitionId: 2021, season: 2024, teamId: 57 },
    ]);
  });

  it('preserves an unknown current matchday as null', () => {
    const result = mapCompetitionTeams(
      {
        ...response,
        season: { ...response.season, currentMatchday: null },
      },
      { isCurrentSeason: true },
    );

    expect(result.competition).toHaveProperty('currentMatchday', null);
  });

  it('uses display fallbacks while preserving unknown team metadata', () => {
    const result = mapTeam({
      ...team,
      shortName: null,
      tla: null,
      crest: null,
      clubColors: null,
    });

    expect(result).toEqual({
      ...team,
      shortName: team.name,
      tla: '',
      crest: null,
      clubColors: null,
    });
  });

  it('uses the same fallbacks for blank display values', () => {
    const result = mapTeam({ ...team, shortName: '   ', tla: '   ' });

    expect(result).toMatchObject({ shortName: team.name, tla: '' });
  });

  it('keeps an empty team list and its membership list empty', () => {
    const result = mapCompetitionTeams({ ...response, teams: [] });

    expect(result.teams).toEqual([]);
    expect(result.teamCompetitions).toEqual([]);
  });
});
