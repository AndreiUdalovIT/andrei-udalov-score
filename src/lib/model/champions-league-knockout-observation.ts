import type { MatchStatus } from '@/lib/types/football';

import type {
  KnockoutExtraTimeInput,
  KnockoutLegInput,
  KnockoutPenaltiesInput,
} from './knockout-sampler';

export const championsLeagueKnockoutStages = [
  'PLAYOFFS',
  'LAST_16',
  'QUARTER_FINALS',
  'SEMI_FINALS',
  'FINAL',
] as const;

export type ChampionsLeagueKnockoutObservation = {
  matchId: number;
  utcDate: Date;
  observedAt: Date;
  status: MatchStatus;
  homeTeamId: number | null;
  awayTeamId: number | null;
  stage: (typeof championsLeagueKnockoutStages)[number];
  /** Null when the result is still unknown or its periods cannot be reconciled. */
  result: {
    regulation: Omit<Extract<KnockoutLegInput, { kind: 'known-result' }>, 'leg'>;
    extraTime: Extract<KnockoutExtraTimeInput, { kind: 'known-result' }> | null;
    penalties: Extract<KnockoutPenaltiesInput, { kind: 'known-result' }> | null;
  } | null;
};
