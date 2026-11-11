import type { ModelMatch } from './matches';
import { calculateTeamStrengths, type VenueStrength } from './team-strengths';

export type RegularizedStrengthOptions = {
  halfLifeDays: number;
  priorMatchCount: number;
  minEffectiveMatchCount: number;
};

export type RegularizedVenueStrength = VenueStrength & {
  lowData: boolean;
};

function regularizeVenue(
  strength: VenueStrength | null,
  priorMatchCount: number,
  minEffectiveMatchCount: number,
): RegularizedVenueStrength | null {
  if (strength === null) return null;

  const effectiveMatches = strength.effectiveMatchCount;
  const weight = effectiveMatches / (effectiveMatches + priorMatchCount);

  return {
    ...strength,
    attack: strength.attack === null ? null : 1 + (strength.attack - 1) * weight,
    defence: strength.defence === null ? null : 1 + (strength.defence - 1) * weight,
    lowData:
      effectiveMatches < minEffectiveMatchCount ||
      strength.attack === null ||
      strength.defence === null,
  };
}

/** Pull observed venue coefficients toward league-average strength (1). */
export function calculateRegularizedTeamStrengths(
  teamIds: readonly number[],
  matches: readonly ModelMatch[],
  before: Date,
  {
    halfLifeDays,
    priorMatchCount,
    minEffectiveMatchCount,
  }: RegularizedStrengthOptions,
) {
  if (!Number.isFinite(priorMatchCount) || priorMatchCount <= 0) {
    throw new RangeError('priorMatchCount must be finite and positive');
  }
  if (!Number.isFinite(minEffectiveMatchCount) || minEffectiveMatchCount < 1) {
    throw new RangeError('minEffectiveMatchCount must be finite and at least 1');
  }

  const { league, teams } = calculateTeamStrengths(
    teamIds,
    matches,
    before,
    halfLifeDays,
  );

  return {
    league,
    teams: teams.map((team) => ({
      ...team,
      home: regularizeVenue(team.home, priorMatchCount, minEffectiveMatchCount),
      away: regularizeVenue(team.away, priorMatchCount, minEffectiveMatchCount),
    })),
  };
}
