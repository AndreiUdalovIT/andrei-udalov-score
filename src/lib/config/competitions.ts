/** Stable identifiers and UI labels. Season rules are configured separately. */
export const competitionConfig = {
  PL: { slug: 'pl', label: 'АПЛ' },
  PD: { slug: 'pd', label: 'Ла Лига' },
  BL1: { slug: 'bl1', label: 'Бундеслига' },
  SA: { slug: 'sa', label: 'Серия А' },
  FL1: { slug: 'fl1', label: 'Лига 1' },
  CL: { slug: 'cl', label: 'Лига чемпионов' },
  ELC: { slug: 'elc', label: 'Чемпионшип' },
} as const;

export type CompetitionCode = keyof typeof competitionConfig;

/** ELC supplies promoted-team history and is not listed as a site competition. */
export const siteCompetitionCodes = [
  'PL',
  'PD',
  'BL1',
  'SA',
  'FL1',
  'CL',
] as const satisfies readonly CompetitionCode[];

export type SiteCompetitionCode = (typeof siteCompetitionCodes)[number];
