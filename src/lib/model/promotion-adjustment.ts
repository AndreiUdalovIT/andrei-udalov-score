import type { ModelMatch } from './matches';
import {
  calculateRegularizedTeamStrengths,
  type RegularizedStrengthOptions,
  type RegularizedVenueStrength,
} from './regularized-strengths';

export type PromotionAdjustmentOptions = RegularizedStrengthOptions & {
  minTeamCount: number;
};

export type PromotionVenueAdjustment = {
  teamCount: number;
  attack: number | null;
  defence: number | null;
};

type VenuePair = readonly [
  championship: RegularizedVenueStrength | null,
  premierLeague: RegularizedVenueStrength | null,
];

function estimateVenueAdjustment(
  pairs: readonly VenuePair[],
  minTeamCount: number,
): PromotionVenueAdjustment {
  let teamCount = 0;
  let attackLogSum = 0;
  let defenceLogSum = 0;

  for (const [championship, premierLeague] of pairs) {
    if (
      championship === null ||
      premierLeague === null ||
      championship.lowData ||
      premierLeague.lowData ||
      championship.attack === null ||
      championship.defence === null ||
      premierLeague.attack === null ||
      premierLeague.defence === null ||
      championship.attack <= 0 ||
      championship.defence <= 0 ||
      premierLeague.attack <= 0 ||
      premierLeague.defence <= 0
    ) {
      continue;
    }

    teamCount += 1;
    attackLogSum += Math.log(premierLeague.attack) - Math.log(championship.attack);
    defenceLogSum +=
      Math.log(premierLeague.defence) - Math.log(championship.defence);
  }

  const attack =
    teamCount >= minTeamCount ? Math.exp(attackLogSum / teamCount) : NaN;
  const defence =
    teamCount >= minTeamCount ? Math.exp(defenceLogSum / teamCount) : NaN;

  return {
    teamCount,
    attack: Number.isFinite(attack) && attack > 0 ? attack : null,
    defence: Number.isFinite(defence) && defence > 0 ? defence : null,
  };
}

/**
 * Geometric mean of paired PL / ELC coefficients, with equal weight per club.
 * The caller supplies a completed earlier PL season, its preceding ELC season
 * and their promoted clubs. Both match samples must be scoped to the main stage.
 * The season being predicted must be excluded from this calibration cohort.
 */
export function estimatePromotionAdjustment(
  promotedTeamIds: readonly number[],
  championshipMatches: readonly ModelMatch[],
  premierLeagueMatches: readonly ModelMatch[],
  before: Date,
  { minTeamCount, ...strengthOptions }: PromotionAdjustmentOptions,
): { home: PromotionVenueAdjustment; away: PromotionVenueAdjustment } {
  if (!Number.isSafeInteger(minTeamCount) || minTeamCount < 1) {
    throw new RangeError('minTeamCount must be a positive safe integer');
  }

  const championship = calculateRegularizedTeamStrengths(
    promotedTeamIds,
    championshipMatches,
    before,
    strengthOptions,
  );
  const premierLeague = calculateRegularizedTeamStrengths(
    promotedTeamIds,
    premierLeagueMatches,
    before,
    strengthOptions,
  );
  const premierLeagueByTeam = new Map(
    premierLeague.teams.map((team) => [team.teamId, team]),
  );
  const homePairs: VenuePair[] = [];
  const awayPairs: VenuePair[] = [];

  for (const team of championship.teams) {
    const promoted = premierLeagueByTeam.get(team.teamId);
    homePairs.push([team.home, promoted?.home ?? null]);
    awayPairs.push([team.away, promoted?.away ?? null]);
  }

  return {
    home: estimateVenueAdjustment(homePairs, minTeamCount),
    away: estimateVenueAdjustment(awayPairs, minTeamCount),
  };
}
