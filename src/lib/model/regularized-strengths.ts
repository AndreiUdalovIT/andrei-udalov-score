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

export type VenueStrengthPrior = {
  attack: number;
  defence: number;
};

export type TeamStrengthPrior = {
  home: VenueStrengthPrior | null;
  away: VenueStrengthPrior | null;
};

function regularizeVenue(
  strength: VenueStrength | null,
  priorMatchCount: number,
  minEffectiveMatchCount: number,
  prior?: VenueStrengthPrior | null,
): RegularizedVenueStrength | null {
  if (
    prior &&
    (!Number.isFinite(prior.attack) ||
      !Number.isFinite(prior.defence) ||
      prior.attack < 0 ||
      prior.defence < 0)
  ) {
    throw new RangeError('prior coefficients must be finite and non-negative');
  }

  if (strength === null) {
    if (!prior) return null;
    return {
      matchCount: 0,
      effectiveMatchCount: 0,
      attack: prior.attack,
      defence: prior.defence,
      lowData: true,
    };
  }

  const effectiveMatches = strength.effectiveMatchCount;
  const totalMatches = effectiveMatches + priorMatchCount;
  const matchWeight = effectiveMatches / totalMatches;
  const priorWeight = priorMatchCount / totalMatches;

  return {
    ...strength,
    attack:
      strength.attack === null
        ? null
        : strength.attack * matchWeight + (prior?.attack ?? 1) * priorWeight,
    defence:
      strength.defence === null
        ? null
        : strength.defence * matchWeight + (prior?.defence ?? 1) * priorWeight,
    lowData:
      effectiveMatches < minEffectiveMatchCount ||
      strength.attack === null ||
      strength.defence === null,
  };
}

/** Pull venue coefficients toward the supplied prior or league average (1). */
export function calculateRegularizedTeamStrengths(
  teamIds: readonly number[],
  matches: readonly ModelMatch[],
  before: Date,
  {
    halfLifeDays,
    priorMatchCount,
    minEffectiveMatchCount,
  }: RegularizedStrengthOptions,
  priors?: ReadonlyMap<number, TeamStrengthPrior>,
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
    teams: teams.map((team) => {
      const prior = priors?.get(team.teamId);
      return {
        ...team,
        home: regularizeVenue(
          team.home,
          priorMatchCount,
          minEffectiveMatchCount,
          prior?.home,
        ),
        away: regularizeVenue(
          team.away,
          priorMatchCount,
          minEffectiveMatchCount,
          prior?.away,
        ),
      };
    }),
  };
}
