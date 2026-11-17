import type { PoissonDistributionOptions } from './poisson-distribution';
import {
  createPoissonScoreSampler,
  POISSON_SCORE_SAMPLING_ALGORITHM,
  type PoissonScoreSampler,
} from './poisson-score-sampler';

export const SEASON_CALENDAR_SAMPLING_ALGORITHM =
  'fixture-id-ordered-poisson-calendar-v1';

type FixtureIdentity = {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
};

export type SeasonCalendarFixture = Readonly<
  FixtureIdentity &
    (
      | {
          kind: 'known-result';
          homeGoals90: number;
          awayGoals90: number;
        }
      | {
          kind: 'forecast';
          homeRate90: number;
          awayRate90: number;
        }
    )
>;

export type SeasonFixtureScore = FixtureIdentity & {
  source: 'known-result' | 'simulated';
  homeGoals90: number;
  awayGoals90: number;
};

export type SeasonCalendarSampler = {
  readonly algorithm: typeof SEASON_CALENDAR_SAMPLING_ALGORITHM;
  readonly scoreSamplingAlgorithm: typeof POISSON_SCORE_SAMPLING_ALGORITHM;
  readonly fixedFixtureCount: number;
  readonly simulatedFixtureCount: number;
  /** Union bound for one whole calendar, excluding round-off and RNG resolution. */
  readonly tailUpperBound: number;
  /** Fresh results in ascending fixture ID order; known results consume no draws. */
  readonly sample: (random: () => number) => SeasonFixtureScore[];
};

type PreparedFixture = FixtureIdentity &
  (
    | { kind: 'known-result'; homeGoals90: number; awayGoals90: number }
    | { kind: 'forecast'; sampler: PoissonScoreSampler }
  );

/**
 * Prepare a caller-scoped snapshot of known 90-minute results and forecasts.
 * The caller selects eligible statuses, the data cutoff and a complete fixture
 * set for the intended season and stage. This function does not certify them.
 * Rates and known results are copied and remain fixed across repeated runs.
 * Forecasts consume two draws each, in ascending fixture ID order.
 * tailUpperBound applies to one run; repeated runs need a combined error budget.
 * Return null if any forecast cannot satisfy its sampling options. All supplied
 * fixtures are still validated, including those after an unavailable forecast.
 */
export function createSeasonCalendarSampler(
  fixtures: readonly SeasonCalendarFixture[],
  options: Readonly<PoissonDistributionOptions>,
): SeasonCalendarSampler | null {
  // Validate options even for empty or fully completed calendars.
  createPoissonScoreSampler(0, 0, options);

  const seen = new Set<number>();
  const prepared: PreparedFixture[] = [];
  let unavailable = false;
  let fixedFixtureCount = 0;
  let simulatedFixtureCount = 0;
  let tailUpperBound = 0;

  for (const fixture of [...fixtures].sort((left, right) => left.id - right.id)) {
    const identity = {
      id: fixture.id,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
    };
    if (
      Object.values(identity).some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      identity.homeTeamId === identity.awayTeamId ||
      seen.has(identity.id)
    ) {
      throw new RangeError(
        'fixtures require unique positive IDs and distinct positive team IDs',
      );
    }
    seen.add(identity.id);

    if (fixture.kind === 'known-result') {
      const { homeGoals90, awayGoals90 } = fixture;
      if (
        !Number.isSafeInteger(homeGoals90) ||
        homeGoals90 < 0 ||
        !Number.isSafeInteger(awayGoals90) ||
        awayGoals90 < 0
      ) {
        throw new RangeError('known goals must be non-negative safe integers');
      }
      prepared.push({ ...identity, kind: 'known-result', homeGoals90, awayGoals90 });
      fixedFixtureCount += 1;
    } else if (fixture.kind === 'forecast') {
      const sampler = createPoissonScoreSampler(
        fixture.homeRate90,
        fixture.awayRate90,
        options,
      );
      simulatedFixtureCount += 1;
      if (sampler === null) {
        unavailable = true;
      } else {
        prepared.push({ ...identity, kind: 'forecast', sampler });
        tailUpperBound = Math.min(1, tailUpperBound + sampler.tailUpperBound);
      }
    } else {
      throw new RangeError('fixture kind must be known-result or forecast');
    }
  }
  if (unavailable) return null;

  return {
    algorithm: SEASON_CALENDAR_SAMPLING_ALGORITHM,
    scoreSamplingAlgorithm: POISSON_SCORE_SAMPLING_ALGORITHM,
    fixedFixtureCount,
    simulatedFixtureCount,
    tailUpperBound,
    sample(random) {
      return prepared.map<SeasonFixtureScore>((fixture) => {
        const identity = {
          id: fixture.id,
          homeTeamId: fixture.homeTeamId,
          awayTeamId: fixture.awayTeamId,
        };
        if (fixture.kind === 'known-result') {
          return {
            ...identity,
            source: 'known-result',
            homeGoals90: fixture.homeGoals90,
            awayGoals90: fixture.awayGoals90,
          };
        }
        const score = fixture.sampler.sample(random);
        return {
          ...identity,
          source: 'simulated',
          homeGoals90: score.homeGoals,
          awayGoals90: score.awayGoals,
        };
      });
    },
  };
}
