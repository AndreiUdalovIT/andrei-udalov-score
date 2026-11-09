import type { CompetitionCode } from './competitions';

export type CompetitionTab =
  'table' | 'matches' | 'bracket' | 'scorers' | 'charts' | 'forecast';

/** Main-stage metadata and the tabs available on a competition screen. */
export type CompetitionSeasonConfig = {
  readonly format: 'round-robin' | 'groups' | 'league-phase';
  readonly mainStage: 'REGULAR_SEASON' | 'GROUP_STAGE' | 'LEAGUE_STAGE';
  readonly mainStageLabel: string;
  readonly teamCount: number;
  readonly matchdays: number;
  readonly tabs: readonly {
    readonly value: CompetitionTab;
    readonly label: string;
  }[];
};

const domesticFormat = {
  format: 'round-robin',
  mainStage: 'REGULAR_SEASON',
  mainStageLabel: 'Чемпионат',
  tabs: [
    { value: 'table', label: 'Таблица' },
    { value: 'matches', label: 'Матчи' },
    { value: 'scorers', label: 'Бомбардиры' },
    { value: 'charts', label: 'Графики' },
    { value: 'forecast', label: 'Прогноз сезона' },
  ],
} as const;

const domesticSeasons = {
  PL: { ...domesticFormat, teamCount: 20, matchdays: 38 },
  PD: { ...domesticFormat, teamCount: 20, matchdays: 38 },
  BL1: { ...domesticFormat, teamCount: 18, matchdays: 34 },
  SA: { ...domesticFormat, teamCount: 20, matchdays: 38 },
  FL1: { ...domesticFormat, teamCount: 18, matchdays: 34 },
  ELC: { ...domesticFormat, teamCount: 24, matchdays: 46, tabs: [] },
} as const;

const championsLeagueTabs = [
  { value: 'table', label: 'Таблица' },
  { value: 'matches', label: 'Матчи' },
  { value: 'bracket', label: 'Сетка' },
  { value: 'scorers', label: 'Бомбардиры' },
  { value: 'forecast', label: 'Прогноз турнира' },
] as const;

const championsLeagueGroups = {
  format: 'groups',
  mainStage: 'GROUP_STAGE',
  mainStageLabel: 'Групповой этап',
  teamCount: 32,
  matchdays: 6,
  tabs: championsLeagueTabs,
} as const;

const championsLeaguePhase = {
  format: 'league-phase',
  mainStage: 'LEAGUE_STAGE',
  mainStageLabel: 'Общий этап',
  teamCount: 36,
  matchdays: 8,
  tabs: championsLeagueTabs,
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
