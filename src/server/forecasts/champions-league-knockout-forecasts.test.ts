import { describe, expect, it, vi } from 'vitest';

import { createChampionsLeagueKnockoutForecasts } from './champions-league-knockout-forecasts';

vi.mock('server-only', () => ({}));

function venue(attack: number, defence: number) {
  return {
    attack,
    defence,
    matchCount: 4,
    effectiveMatchCount: 4,
    lowData: false,
  };
}

function strengthSnapshot() {
  return {
    league: {
      matchCount: 16,
      effectiveMatchCount: 16,
      homeGoalsPerMatch: 2,
      awayGoalsPerMatch: 1,
    },
    teams: [
      { teamId: 1, home: venue(1.5, 0.75), away: venue(0.75, 1.25) },
      { teamId: 2, home: venue(1.25, 1.5), away: venue(0.5, 0.5) },
    ],
  };
}

const silver = { source: 'simulated', club: { teamId: 1, position: 1 } } as const;
const blue = { source: 'simulated', club: { teamId: 2, position: 2 } } as const;
const shootout = { kind: 'forecast', firstTeamWinProbability: 0.5 };

describe('createChampionsLeagueKnockoutForecasts', () => {
  it('uses the selected venue and supplies conditional forecasts only for the return leg', () => {
    const forecasts = createChampionsLeagueKnockoutForecasts(strengthSnapshot());

    expect(forecasts.leg({ homeTeamId: 2, awayTeamId: 1, leg: 1 })).toEqual({
      homeRate90: 3.125,
      awayRate90: 1.125,
      extraTime: null,
      penalties: null,
    });
    expect(forecasts.leg({ homeTeamId: 1, awayTeamId: 2, leg: 2 })).toEqual({
      homeRate90: 1.5,
      awayRate90: 0.375,
      extraTime: { kind: 'forecast', homeRate30: 0.5, awayRate30: 0.125 },
      penalties: shootout,
    });
  });

  it('keeps neutral rates tied to the clubs when the administrative sides swap', () => {
    const forecasts = createChampionsLeagueKnockoutForecasts(strengthSnapshot());

    expect(forecasts.final({ silver, blue })).toEqual({
      regulation: {
        kind: 'forecast',
        silverNeutralRate90: 1.3125,
        blueNeutralRate90: 1.75,
      },
      extraTime: {
        kind: 'forecast',
        silverNeutralRate30: 0.4375,
        blueNeutralRate30: 1.75 / 3,
      },
      penalties: shootout,
    });
    expect(forecasts.final({ silver: blue, blue: silver })).toMatchObject({
      regulation: { silverNeutralRate90: 1.75, blueNeutralRate90: 1.3125 },
      penalties: shootout,
    });
  });

  it('requires both orientations for a neutral forecast and the requested one for a leg', () => {
    const strengths = strengthSnapshot();
    const forecasts = createChampionsLeagueKnockoutForecasts({
      ...strengths,
      teams: strengths.teams.map((team) =>
        team.teamId === 2 ? { ...team, home: null } : team,
      ),
    });

    expect(forecasts.leg({ homeTeamId: 1, awayTeamId: 2, leg: 2 })).not.toBeNull();
    expect(forecasts.leg({ homeTeamId: 2, awayTeamId: 1, leg: 2 })).toBeNull();
    expect(forecasts.final({ silver, blue })).toBeNull();
  });

  it('returns no forecast for an unknown club or missing league averages', () => {
    const strengths = strengthSnapshot();
    const known = createChampionsLeagueKnockoutForecasts(strengths);
    const missing = createChampionsLeagueKnockoutForecasts({
      ...strengths,
      league: null,
    });
    const fixture = { homeTeamId: 1, awayTeamId: 2, leg: 1 } as const;

    expect(known.leg({ ...fixture, awayTeamId: 3 })).toBeNull();
    expect(known.leg({ ...fixture, awayTeamId: 1 })).toBeNull();
    expect(missing.leg(fixture)).toBeNull();
    expect(missing.final({ silver, blue })).toBeNull();
  });

  it('retains the same rates when the source snapshot changes after creation', () => {
    const strengths = strengthSnapshot();
    const forecasts = createChampionsLeagueKnockoutForecasts(strengths);
    const fixture = { homeTeamId: 1, awayTeamId: 2, leg: 2 } as const;
    const output = forecasts.leg(fixture);

    strengths.teams[0]!.home.attack = 10;
    strengths.league.homeGoalsPerMatch = 5;

    expect(forecasts.leg(fixture)).toEqual(output);
  });
});
