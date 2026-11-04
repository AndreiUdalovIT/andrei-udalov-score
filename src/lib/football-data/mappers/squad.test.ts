import { describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/squad.json';
import { squadResponseSchema } from '../schemas/squad';
import { mapSquad } from './squad';

vi.mock('server-only', () => ({}));

const arsenal = squadResponseSchema.parse(fixture.arsenal);
const clubBrugge = squadResponseSchema.parse(fixture.clubBrugge);

describe('squad mapper', () => {
  it('maps the team and binds its players without converting birth dates', () => {
    expect(mapSquad(arsenal)).toEqual({
      team: {
        id: 57,
        name: 'Arsenal FC',
        shortName: 'Arsenal',
        tla: 'ARS',
        crest: 'https://crests.football-data.org/57.png',
        clubColors: 'Red / White',
      },
      squadPlayers: [
        {
          id: 3189,
          teamId: 57,
          name: 'Kepa Arrizabalaga',
          position: 'Goalkeeper',
          dateOfBirth: '1994-10-03',
          nationality: 'Spain',
        },
        {
          id: 302255,
          teamId: 57,
          name: 'Maalik Hashi',
          position: null,
          dateOfBirth: '2008-09-03',
          nationality: 'England',
        },
      ],
    });
  });

  it('uses another team ID and preserves an unknown birth date', () => {
    const result = mapSquad(clubBrugge);

    expect(result.team.id).toBe(851);
    expect(result.squadPlayers[1]).toMatchObject({
      id: 272459,
      teamId: 851,
      dateOfBirth: null,
    });
  });

  it('preserves unknown player details without inventing values', () => {
    const result = mapSquad({
      ...arsenal,
      squad: arsenal.squad.map((player) => ({
        ...player,
        position: null,
        dateOfBirth: null,
        nationality: null,
      })),
    });

    expect(
      result.squadPlayers.map(({ position, dateOfBirth, nationality }) => ({
        position,
        dateOfBirth,
        nationality,
      })),
    ).toEqual([
      { position: null, dateOfBirth: null, nationality: null },
      { position: null, dateOfBirth: null, nationality: null },
    ]);
  });

  it('reuses the team display fallbacks', () => {
    const result = mapSquad({
      ...arsenal,
      shortName: null,
      tla: null,
      crest: null,
      clubColors: null,
    });

    expect(result.team).toEqual({
      id: 57,
      name: 'Arsenal FC',
      shortName: 'Arsenal FC',
      tla: '',
      crest: null,
      clubColors: null,
    });
  });

  it('keeps the team context when the squad is empty', () => {
    const result = mapSquad({ ...arsenal, squad: [] });

    expect(result.team.id).toBe(57);
    expect(result.squadPlayers).toEqual([]);
  });

  it('rejects a repeated player in the same squad', () => {
    expect(() =>
      mapSquad({
        ...arsenal,
        squad: [...arsenal.squad, ...arsenal.squad],
      }),
    ).toThrow('Squad response contains a duplicate player');
  });
});
