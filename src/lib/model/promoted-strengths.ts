import type { ModelMatch } from './matches';
import type { PromotionVenueAdjustment } from './promotion-adjustment';
import {
  calculateRegularizedTeamStrengths,
  type RegularizedStrengthOptions,
  type RegularizedVenueStrength,
  type VenueStrengthPrior,
} from './regularized-strengths';

export type ChampionshipStrengthPrior = VenueStrengthPrior & {
  matchCount: number;
  effectiveMatchCount: number;
};

function adjustChampionshipVenue(
  strength: RegularizedVenueStrength | null,
  adjustment: PromotionVenueAdjustment | undefined,
): ChampionshipStrengthPrior | null {
  if (
    strength === null ||
    strength.lowData ||
    strength.attack === null ||
    strength.defence === null ||
    adjustment === undefined ||
    adjustment.attack === null ||
    adjustment.defence === null ||
    adjustment.attack <= 0 ||
    adjustment.defence <= 0
  ) {
    return null;
  }

  const attack = strength.attack * adjustment.attack;
  const defence = strength.defence * adjustment.defence;
  if (!Number.isFinite(attack) || !Number.isFinite(defence)) return null;

  return {
    attack,
    defence,
    matchCount: strength.matchCount,
    effectiveMatchCount: strength.effectiveMatchCount,
  };
}

function withChampionshipPrior(
  strength: RegularizedVenueStrength | null,
  prior: ChampionshipStrengthPrior | null,
) {
  if (
    strength === null ||
    strength.attack === null ||
    strength.defence === null ||
    (prior === null && strength.lowData)
  ) {
    return null;
  }

  return { ...strength, championshipPrior: prior };
}

/**
 * The caller supplies current PL newcomers and the preceding ELC main stage.
 * PL matches define the league baseline and native venue sample counts.
 * A missing ELC prior requires sufficient PL evidence for that venue.
 * Historical calibration of the adjustment is the caller's responsibility.
 */
export function calculatePromotedTeamStrengths(
  promotedTeamIds: readonly number[],
  championshipMatches: readonly ModelMatch[],
  premierLeagueMatches: readonly ModelMatch[],
  before: Date,
  adjustment: {
    home: PromotionVenueAdjustment;
    away: PromotionVenueAdjustment;
  } | null,
  options: RegularizedStrengthOptions,
) {
  const championship = calculateRegularizedTeamStrengths(
    promotedTeamIds,
    championshipMatches,
    before,
    options,
  );
  const priors = new Map(
    championship.teams.map((team) => [
      team.teamId,
      {
        home: adjustChampionshipVenue(team.home, adjustment?.home),
        away: adjustChampionshipVenue(team.away, adjustment?.away),
      },
    ]),
  );
  const premierLeague = calculateRegularizedTeamStrengths(
    promotedTeamIds,
    premierLeagueMatches,
    before,
    options,
    priors,
  );

  return {
    league: premierLeague.league,
    teams: premierLeague.teams.map((team) => {
      const prior = priors.get(team.teamId);
      return {
        ...team,
        home: withChampionshipPrior(team.home, prior?.home ?? null),
        away: withChampionshipPrior(team.away, prior?.away ?? null),
      };
    }),
  };
}
