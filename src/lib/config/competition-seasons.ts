import type { Zone } from '@/lib/types/football';

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
  /** Inclusive positions within one table, including a single group. */
  readonly zones: readonly {
    readonly from: number;
    readonly to: number;
    readonly zone: Zone;
    readonly label: string;
  }[];
  readonly rankingNote: string | null;
  readonly tabs: readonly {
    readonly value: CompetitionTab;
    readonly label: string;
  }[];
};

const domesticFormat = {
  format: 'round-robin',
  mainStage: 'REGULAR_SEASON',
  mainStageLabel: 'Чемпионат',
  zones: [],
  rankingNote: null,
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

// UEFA 2023/24, articles 16–17. Positions apply within each group.
const championsLeagueGroups = {
  format: 'groups',
  mainStage: 'GROUP_STAGE',
  mainStageLabel: 'Групповой этап',
  teamCount: 32,
  matchdays: 6,
  zones: [
    { from: 1, to: 2, zone: 'ucl', label: '1/8 финала' },
    { from: 3, to: 3, zone: 'uel', label: 'Стыковые матчи Лиги Европы' },
    { from: 4, to: 4, zone: 'releg', label: 'Выбывание' },
  ],
  rankingNote:
    'В итоговой таблице при равенстве очков сначала сравниваются очки, разница мячей и забитые мячи в личных встречах. ' +
    'Для оставшихся равных команд эти критерии применяются повторно. ' +
    'Затем учитываются разница мячей и забитые мячи во всех матчах группы, голы на выезде, победы, выездные победы, меньшее число дисциплинарных баллов и более высокий коэффициент УЕФА.',
  tabs: championsLeagueTabs,
} as const;

// UEFA 2024/25–2026/27, articles 17–18.
const championsLeaguePhase = {
  format: 'league-phase',
  mainStage: 'LEAGUE_STAGE',
  mainStageLabel: 'Общий этап',
  teamCount: 36,
  matchdays: 8,
  zones: [
    { from: 1, to: 8, zone: 'ucl', label: '1/8 финала' },
    { from: 9, to: 24, zone: 'uel', label: 'Стыковые матчи' },
    { from: 25, to: 36, zone: 'releg', label: 'Выбывание' },
  ],
  rankingNote:
    'При равенстве очков сравниваются разница мячей, забитые мячи, голы на выезде, победы и выездные победы. ' +
    'До завершения этапа полное равенство по этим критериям даёт одинаковое место. ' +
    'В итоговой таблице далее учитываются суммарные очки, разница мячей и забитые мячи соперников, меньшее число дисциплинарных баллов и более высокий коэффициент УЕФА.',
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
