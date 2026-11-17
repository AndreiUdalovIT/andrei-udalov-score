import type { PoissonDistributionOptions } from '@/lib/model/poisson-distribution';

/** Published Poisson model with the calibrated competition strength settings. */
export const predictionModelConfig = {
  version: 'poisson-v1',
  distribution: { tailTolerance: 1e-10, maxGoals: 64 },
} as const satisfies {
  version: string;
  distribution: PoissonDistributionOptions;
};
