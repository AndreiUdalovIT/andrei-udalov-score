import type { LeagueAverages } from './league-averages';
import type { RegularizedVenueStrength } from './regularized-strengths';

export type ExpectedGoals = {
  home: number;
  away: number;
  lowData: boolean;
};

function goalRate(
  average: number,
  attack: number | null,
  defence: number | null,
): number | null {
  if (attack === null || defence === null) return null;

  const factors: [number, number, number] = [average, attack, defence];
  if (factors.some((factor) => !Number.isFinite(factor) || factor < 0)) {
    return null;
  }

  // Balance the product to avoid overflow or underflow in intermediate steps.
  factors.sort((left, right) => left - right);
  const rate = factors[0] * factors[2] * factors[1];
  return Number.isFinite(rate) ? rate : null;
}

/** Use the home team's home venue and the away team's away venue. */
export function calculateExpectedGoals(
  league: LeagueAverages | null,
  homeVenue: RegularizedVenueStrength | null,
  awayVenue: RegularizedVenueStrength | null,
): ExpectedGoals | null {
  if (league === null || homeVenue === null || awayVenue === null) return null;

  const home = goalRate(
    league.homeGoalsPerMatch,
    homeVenue.attack,
    awayVenue.defence,
  );
  const away = goalRate(
    league.awayGoalsPerMatch,
    awayVenue.attack,
    homeVenue.defence,
  );
  if (home === null || away === null) return null;

  return { home, away, lowData: homeVenue.lowData || awayVenue.lowData };
}
