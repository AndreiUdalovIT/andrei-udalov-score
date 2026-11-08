import type { CompetitionCode } from './competitions';

/** Main-stage format; qualifying, promotion and knockout matches are excluded. */
export type CompetitionSeasonConfig = {
  readonly format: 'round-robin' | 'groups' | 'league-phase';
  readonly teamCount: number;
  readonly matchdays: number;
};

const domesticSeasons = {
  PL: { format: 'round-robin', teamCount: 20, matchdays: 38 },
  PD: { format: 'round-robin', teamCount: 20, matchdays: 38 },
  BL1: { format: 'round-robin', teamCount: 18, matchdays: 34 },
  SA: { format: 'round-robin', teamCount: 20, matchdays: 38 },
  FL1: { format: 'round-robin', teamCount: 18, matchdays: 34 },
  ELC: { format: 'round-robin', teamCount: 24, matchdays: 46 },
} as const;

const championsLeagueGroups = {
  format: 'groups',
  teamCount: 32,
  matchdays: 6,
} as const;

const championsLeaguePhase = {
  format: 'league-phase',
  teamCount: 36,
  matchdays: 8,
} as const;

// Starting years are explicit: unconfigured seasons must not inherit old rules.
const competitionSeasons: Readonly<
  Record<number, Readonly<Record<CompetitionCode, CompetitionSeasonConfig>>>
> = {
  2023: { ...domesticSeasons, CL: championsLeagueGroups },
  2024: { ...domesticSeasons, CL: championsLeaguePhase },
  2025: { ...domesticSeasons, CL: championsLeaguePhase },
  2026: { ...domesticSeasons, CL: championsLeaguePhase },
};

export function getCompetitionSeasonConfig(
  competitionCode: CompetitionCode,
  season: number,
): CompetitionSeasonConfig | undefined {
  return competitionSeasons[season]?.[competitionCode];
}
