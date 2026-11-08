import 'server-only';

import type { CompetitionCode } from '@/lib/config/competitions';

export const footballCacheTags = {
  teams: 'football:teams',
  competition: (code: CompetitionCode) => `football:competition:${code}`,
  season: (code: CompetitionCode, season: number) =>
    `football:competition:${code}:season:${season}`,
} as const;
