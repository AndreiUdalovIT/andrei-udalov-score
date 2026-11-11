import { calculateLeagueAverages, type LeagueAverages } from './league-averages';
import type { ModelMatch } from './matches';

export type VenueStrength = {
  matchCount: number;
  attack: number | null;
  /** Goals conceded relative to the league. Lower is stronger. */
  defence: number | null;
};

export type TeamStrength = {
  teamId: number;
  home: VenueStrength | null;
  away: VenueStrength | null;
};

function relativeRate(value: number, baseline: number): number | null {
  const ratio = value / baseline;
  return Number.isFinite(ratio) ? ratio : null;
}

/** Unsmoothed venue coefficients for the caller's competition sample. */
export function calculateTeamStrengths(
  teamIds: readonly number[],
  matches: readonly ModelMatch[],
  before: Date,
  halfLifeDays: number,
): { league: LeagueAverages | null; teams: TeamStrength[] } {
  const league = calculateLeagueAverages(matches, before, halfLifeDays);
  const teams = [...new Set(teamIds)].map((teamId): TeamStrength => {
    const home = calculateLeagueAverages(
      matches.filter((match) => match.homeTeamId === teamId),
      before,
      halfLifeDays,
    );
    const away = calculateLeagueAverages(
      matches.filter((match) => match.awayTeamId === teamId),
      before,
      halfLifeDays,
    );

    return {
      teamId,
      home:
        home === null || league === null
          ? null
          : {
              matchCount: home.matchCount,
              attack: relativeRate(home.homeGoalsPerMatch, league.homeGoalsPerMatch),
              defence: relativeRate(
                home.awayGoalsPerMatch,
                league.awayGoalsPerMatch,
              ),
            },
      away:
        away === null || league === null
          ? null
          : {
              matchCount: away.matchCount,
              attack: relativeRate(away.awayGoalsPerMatch, league.awayGoalsPerMatch),
              defence: relativeRate(
                away.homeGoalsPerMatch,
                league.homeGoalsPerMatch,
              ),
            },
    };
  });

  return { league, teams };
}
