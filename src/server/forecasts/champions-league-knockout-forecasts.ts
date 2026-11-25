import 'server-only';

import { calculateExpectedGoals } from '@/lib/model/expected-goals';
import type { LeagueAverages } from '@/lib/model/league-averages';
import type { RegularizedVenueStrength } from '@/lib/model/regularized-strengths';

import type { ChampionsLeagueKnockoutForecasts } from './champions-league-match-providers';

export type ChampionsLeagueKnockoutStrengths = Readonly<{
  league: Readonly<LeagueAverages> | null;
  teams: readonly Readonly<{
    teamId: number;
    home: Readonly<RegularizedVenueStrength> | null;
    away: Readonly<RegularizedVenueStrength> | null;
  }>[];
}>;

type LegFixture = Pick<
  Parameters<ChampionsLeagueKnockoutForecasts['leg']>[0],
  'homeTeamId' | 'awayTeamId' | 'leg'
>;
type FinalFixture = Pick<
  Parameters<ChampionsLeagueKnockoutForecasts['final']>[0],
  'silver' | 'blue'
>;

const equalShootout = { kind: 'forecast', firstTeamWinProbability: 0.5 } as const;

/**
 * Apply the regular-time model to each venue. For a neutral final, average
 * each club's rates over both orientations. Extra time scales the rates by
 * 30/90, and the shootout uses equal chances. These are scenario assumptions.
 */
export function createChampionsLeagueKnockoutForecasts(
  strengths: ChampionsLeagueKnockoutStrengths,
) {
  const { league, teams } = structuredClone(strengths);
  const byTeam = new Map(teams.map((team) => [team.teamId, team]));

  function expectedGoals(homeTeamId: number, awayTeamId: number) {
    if (homeTeamId === awayTeamId) return null;
    return calculateExpectedGoals(
      league,
      byTeam.get(homeTeamId)?.home ?? null,
      byTeam.get(awayTeamId)?.away ?? null,
    );
  }

  return {
    leg({ homeTeamId, awayTeamId, leg }: LegFixture) {
      const rates = expectedGoals(homeTeamId, awayTeamId);
      if (rates === null) return null;

      return {
        homeRate90: rates.home,
        awayRate90: rates.away,
        extraTime:
          leg === 2
            ? {
                kind: 'forecast',
                homeRate30: rates.home / 3,
                awayRate30: rates.away / 3,
              }
            : null,
        penalties: leg === 2 ? { ...equalShootout } : null,
      };
    },

    final({ silver, blue }: FinalFixture) {
      const silverHome = expectedGoals(silver.club.teamId, blue.club.teamId);
      const blueHome = expectedGoals(blue.club.teamId, silver.club.teamId);
      if (silverHome === null || blueHome === null) return null;

      const silverNeutralRate90 = silverHome.home / 2 + blueHome.away / 2;
      const blueNeutralRate90 = silverHome.away / 2 + blueHome.home / 2;
      return {
        regulation: { kind: 'forecast', silverNeutralRate90, blueNeutralRate90 },
        extraTime: {
          kind: 'forecast',
          silverNeutralRate30: silverNeutralRate90 / 3,
          blueNeutralRate30: blueNeutralRate90 / 3,
        },
        penalties: { ...equalShootout },
      };
    },
  } satisfies ChampionsLeagueKnockoutForecasts;
}
