import type { PromotionAdjustmentOptions } from '@/lib/model/promotion-adjustment';

import type { CompetitionCode } from './competitions';

/**
 * Shared decay and shrinkage selected on 2025/26 main-stage forecasts.
 * Search used half-lives of 30, 60, 90, 180, 365 and 730 days
 * and prior sizes of 1, 3, 6, 12 and 24.
 * Retrospective inputs assume result availability 24 hours after kickoff.
 * Recorded 2026/27 results through 2026-11-08 form the control sample.
 * Effective-sample and promotion-coverage thresholds are policy choices.
 */
const calibratedOptions = {
  halfLifeDays: 730,
  priorMatchCount: 24,
  minEffectiveMatchCount: 3,
  minTeamCount: 2,
} as const;

export const strengthModelOptions = {
  PL: calibratedOptions,
  PD: calibratedOptions,
  BL1: calibratedOptions,
  SA: calibratedOptions,
  FL1: calibratedOptions,
  // Champions League main stages provide fewer home and away matches.
  CL: { ...calibratedOptions, minEffectiveMatchCount: 2 },
  ELC: calibratedOptions,
} as const satisfies Record<CompetitionCode, PromotionAdjustmentOptions>;
