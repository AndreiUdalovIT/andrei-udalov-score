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
  readonly qualificationNote: string | null;
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
  qualificationNote: null,
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
  // Premier League Handbook, rules C.4–C.7 and C.17.
  PL: {
    ...domesticFormat,
    teamCount: 20,
    matchdays: 38,
    rankingNote:
      'При равенстве очков сравниваются разница мячей и забитые мячи. При полном равенстве команды делят место. ' +
      'Если по итогам сезона требуется определить чемпиона, вылет или выход в другие турниры, далее учитываются очки в личных встречах и выездные голы в них. ' +
      'Если равенство сохраняется у двух команд, проводится дополнительный матч на нейтральном поле.',
  },
  // RFEF Reglamento de Competiciones, article 29.
  PD: {
    ...domesticFormat,
    teamCount: 20,
    matchdays: 38,
    rankingNote:
      'В итоговой таблице при равенстве очков двух команд сначала сравнивается разница мячей в личных встречах. Для трёх и более команд сначала учитываются очки и разница мячей в матчах между ними. ' +
      'Затем учитываются общая разница мячей и забитые мячи. После выделения части команд оставшееся равенство разбирается заново по правилам для их числа. ' +
      'Регламент также предусматривает рейтинг Fair Play и дополнительный матч на нейтральном поле.',
  },
  // DFL Spielordnung, § 2 no. 3(c).
  BL1: {
    ...domesticFormat,
    teamCount: 18,
    matchdays: 34,
    rankingNote:
      'При равенстве очков сравниваются общая разница мячей, забитые мячи, суммарный результат личных встреч, выездные голы в личных встречах и все выездные голы. ' +
      'До завершения обоих матчей между командами применяются только разница мячей и забитые мячи. ' +
      'Если по итогам сезона равенство сохраняется, проводится дополнительный матч на нейтральном поле.',
  },
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
  qualificationNote: null,
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
  qualificationNote: null,
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
  2023: {
    ...domesticSeasons,
    PL: {
      ...domesticSeasons.PL,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 5, zone: 'uel', label: 'Лига Европы' },
        { from: 6, to: 6, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Чемпионшип' },
      ],
      qualificationNote:
        'Показаны места, давшие путёвки через итоговую таблицу. ' +
        '«Манчестер Юнайтед» также получил место в Лиге Европы как победитель Кубка Англии.',
    },
    PD: {
      ...domesticSeasons.PD,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 6, zone: 'uel', label: 'Лига Европы' },
        { from: 7, to: 7, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Сегунду' },
      ],
      qualificationNote:
        'Победитель Кубка Испании «Атлетик» занял пятое место. ' +
        'Дополнительное место Лиги Европы получила шестая команда, а место Лиги конференций — седьмая.',
    },
    BL1: {
      ...domesticSeasons.BL1,
      zones: [
        { from: 1, to: 5, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 6, to: 7, zone: 'uel', label: 'Лига Европы' },
        { from: 8, to: 8, zone: 'uecl', label: 'Лига конференций' },
        { from: 16, to: 16, zone: 'playoff', label: 'Стыки за место в Бундеслиге' },
        { from: 17, to: 18, zone: 'releg', label: 'Вылет во 2-ю Бундеслигу' },
      ],
      qualificationNote:
        'Пятое место ЛЧ получено по сезонному рейтингу ассоциаций УЕФА. ' +
        'Победа «Байера» в Кубке Германии передала место Лиги Европы седьмой команде, а место Лиги конференций — восьмой.',
    },
    CL: championsLeagueGroups,
  },
  2024: {
    ...domesticSeasons,
    PL: {
      ...domesticSeasons.PL,
      zones: [
        { from: 1, to: 5, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 6, to: 7, zone: 'uel', label: 'Лига Европы' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Чемпионшип' },
      ],
      qualificationNote:
        'Пятое место ЛЧ получено по сезонному рейтингу ассоциаций УЕФА. «Ноттингем Форест» допущен в Лигу Европы после решения по «Кристал Пэлас». ' +
        '«Тоттенхэм» получил место в ЛЧ как победитель Лиги Европы, «Кристал Пэлас» — место в Лиге конференций.',
    },
    PD: {
      ...domesticSeasons.PD,
      zones: [
        { from: 1, to: 5, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 6, to: 7, zone: 'uel', label: 'Лига Европы' },
        { from: 8, to: 8, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Сегунду' },
      ],
      qualificationNote:
        'Пятое место ЛЧ получено по сезонному рейтингу ассоциаций УЕФА. ' +
        'Победа «Барселоны» в Кубке Испании передала дополнительное место Лиги Европы седьмой команде, а место Лиги конференций — восьмой.',
    },
    BL1: {
      ...domesticSeasons.BL1,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 5, zone: 'uel', label: 'Лига Европы' },
        { from: 6, to: 6, zone: 'uecl', label: 'Лига конференций' },
        { from: 16, to: 16, zone: 'playoff', label: 'Стыки за место в Бундеслиге' },
        { from: 17, to: 18, zone: 'releg', label: 'Вылет во 2-ю Бундеслигу' },
      ],
      qualificationNote:
        'Показаны места, давшие путёвки через итоговую таблицу. ' +
        '«Штутгарт» также получил место в Лиге Европы как победитель Кубка Германии.',
    },
    CL: championsLeaguePhase,
  },
  2025: {
    ...domesticSeasons,
    PL: {
      ...domesticSeasons.PL,
      zones: [
        { from: 1, to: 5, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 6, to: 7, zone: 'uel', label: 'Лига Европы' },
        { from: 8, to: 8, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Чемпионшип' },
      ],
      qualificationNote:
        'Пятое место ЛЧ получено по сезонному рейтингу ассоциаций УЕФА. Кубковые путёвки перераспределены по итоговой таблице. ' +
        '«Кристал Пэлас» также получил место в Лиге Европы как победитель Лиги конференций.',
    },
    PD: {
      ...domesticSeasons.PD,
      zones: [
        { from: 1, to: 5, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 6, to: 6, zone: 'uel', label: 'Лига Европы' },
        { from: 7, to: 7, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Сегунду' },
      ],
      qualificationNote:
        'Пятое место ЛЧ получено по сезонному рейтингу ассоциаций УЕФА. ' +
        '«Реал Сосьедад» также получил место в Лиге Европы как победитель Кубка Испании.',
    },
    BL1: {
      ...domesticSeasons.BL1,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 6, zone: 'uel', label: 'Лига Европы' },
        { from: 7, to: 7, zone: 'uecl', label: 'Лига конференций' },
        { from: 16, to: 16, zone: 'playoff', label: 'Стыки за место в Бундеслиге' },
        { from: 17, to: 18, zone: 'releg', label: 'Вылет во 2-ю Бундеслигу' },
      ],
      qualificationNote:
        'Победитель Кубка Германии уже квалифицировался в Лигу чемпионов. ' +
        'Поэтому дополнительное место Лиги Европы получила шестая команда, а место Лиги конференций — седьмая.',
    },
    CL: championsLeaguePhase,
  },
  2026: {
    ...domesticSeasons,
    PL: {
      ...domesticSeasons.PL,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 5, zone: 'uel', label: 'Лига Европы' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Чемпионшип' },
      ],
      qualificationNote:
        'Показана базовая квота по таблице. Дополнительное место ЛЧ зависит от сезонного рейтинга ассоциаций УЕФА. ' +
        'Победители Кубка Англии и Кубка лиги получают места в ЛЕ и ЛК, возможны перераспределения путёвок. Победы в еврокубках также влияют на распределение.',
    },
    PD: {
      ...domesticSeasons.PD,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 5, zone: 'uel', label: 'Лига Европы' },
        { from: 6, to: 6, zone: 'uecl', label: 'Лига конференций' },
        { from: 18, to: 20, zone: 'releg', label: 'Вылет в Сегунду' },
      ],
      qualificationNote:
        'Показана базовая квота по таблице. Дополнительное место ЛЧ зависит от сезонного рейтинга ассоциаций УЕФА. ' +
        'Победитель Кубка Испании получает место в ЛЕ, возможно перераспределение путёвок. Победы в еврокубках также влияют на распределение.',
    },
    BL1: {
      ...domesticSeasons.BL1,
      zones: [
        { from: 1, to: 4, zone: 'ucl', label: 'Лига чемпионов' },
        { from: 5, to: 5, zone: 'uel', label: 'Лига Европы' },
        { from: 6, to: 6, zone: 'uecl', label: 'Лига конференций' },
        { from: 16, to: 16, zone: 'playoff', label: 'Стыки за место в Бундеслиге' },
        { from: 17, to: 18, zone: 'releg', label: 'Вылет во 2-ю Бундеслигу' },
      ],
      qualificationNote:
        'Показана базовая квота по таблице. Дополнительное место ЛЧ зависит от сезонного рейтинга ассоциаций УЕФА. ' +
        'Победитель Кубка Германии получает место в ЛЕ, возможно перераспределение путёвок. Победы в еврокубках также влияют на распределение.',
    },
    CL: championsLeaguePhase,
  },
};

export function getCompetitionSeasonConfig(
  competitionCode: CompetitionCode,
  season: number,
): CompetitionSeasonConfig | undefined {
  return competitionSeasons[season]?.[competitionCode];
}
