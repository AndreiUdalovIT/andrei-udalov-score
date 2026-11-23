import { describe, expect, it } from 'vitest';

import {
  createKnockoutSampler,
  KNOCKOUT_SAMPLING_ALGORITHM,
  type KnockoutSamplingInput,
  type KnockoutLegInput,
} from './knockout-sampler';
import { createPoissonScoreSampler } from './poisson-score-sampler';
import { createSeededRandom } from './seeded-random';
import type { SerieAPlayOffEvent } from './serie-a-play-off-plan';
import { resolveSerieAPlayOffResult } from './serie-a-play-off-result';

const options = Object.freeze({ tailTolerance: 1e-10, maxGoals: 64 });
const forecast: KnockoutLegInput = {
  leg: 1,
  homeTeamId: 1,
  awayTeamId: 2,
  kind: 'forecast',
  homeRate90: 1.5,
  awayRate90: 0.8,
};
const known: KnockoutLegInput = {
  leg: 1,
  homeTeamId: 1,
  awayTeamId: 2,
  kind: 'known-result',
  homeGoals90: 1,
  awayGoals90: 1,
};

function input(
  overrides: Partial<KnockoutSamplingInput> = {},
): KnockoutSamplingInput {
  return {
    firstTeamId: 1,
    secondTeamId: 2,
    legs: [forecast],
    extraTime: { kind: 'none' },
    penalties: { kind: 'forecast', firstTeamWinProbability: 0.65 },
    sampling: options,
    ...overrides,
  };
}

function randomFrom(values: readonly number[]) {
  let calls = 0;
  return { random: () => values[calls++]!, calls: () => calls };
}

function event(kind: 'title' | 'survival'): SerieAPlayOffEvent {
  const title = kind === 'title';
  return {
    kind,
    points: 50,
    pointsGroupTeamIds: [1, 2],
    higherSlot: { position: title ? 1 : 17, candidateTeamIds: [1] },
    lowerSlot: { position: title ? 2 : 18, candidateTeamIds: [2] },
    selection: 'ordered-pair-known',
    decision: 'play-off-required',
    normalFormat: {
      legs: title ? 1 : 2,
      firstLegHomeSlot: title ? 'higher' : 'lower',
      secondLegHomeSlot: title ? null : 'higher',
      neutralVenueAlternative: null,
      extraTime: false,
      awayGoals: false,
      penaltiesOnTie: true,
    },
  };
}

describe('one/two-leg knockout score sampling and conditional tie resolution', () => {
  it('matches independent score quantiles and skips unused tie-break draws', () => {
    const sampler = createKnockoutSampler(input())!;
    const random = randomFrom([0.05, 0.5]);
    const result = sampler.sample(random.random);
    expect(result).toMatchObject({
      algorithm: 'aggregate-no-away-goals-conditional-extra-time-penalties-v1',
      winnerTeamId: 2,
      loserTeamId: 1,
      method: 'regulation-goals',
      aggregateGoals90: { first: 0, second: 1 },
      aggregateGoalsAfterExtraTime: null,
      extraTime: null,
      shootout: null,
      legs: [{ leg: 1, source: 'simulated', homeGoals90: 0, awayGoals90: 1 }],
    });
    expect(random.calls()).toBe(2);
    expect(sampler.algorithm).toBe(KNOCKOUT_SAMPLING_ALGORITHM);
    expect(sampler.calendarSamplingAlgorithm).toBe(
      'fixture-id-ordered-poisson-calendar-v1',
    );
    expect(sampler.scoreSamplingAlgorithm).toBe(
      'independent-poisson-conditioned-cdf-v1',
    );
    expect(sampler.fixedLegCount).toBe(0);
    expect(sampler.simulatedLegCount).toBe(1);
    expect(sampler.extraTimePolicy).toBe('none');
  });

  it.each([
    { uniform: 0.649999999999, winner: 1 },
    { uniform: 0.65, winner: 2 },
    { uniform: 1 - 2 ** -53, winner: 2 },
  ])(
    'uses the strict shootout probability boundary at $uniform',
    ({ uniform, winner }) => {
      const random = randomFrom([0.9, 0.99, uniform]);
      const result = createKnockoutSampler(input())!.sample(random.random);
      expect(result.aggregateGoals90).toEqual({ first: 3, second: 3 });
      expect(result.method).toBe('penalties');
      expect(result.shootout).toEqual({ winnerTeamId: winner, source: 'simulated' });
      expect(random.calls()).toBe(3);
    },
  );

  it.each([0, 1])('consumes one shootout draw even for chance %s', (probability) => {
    const random = randomFrom([0.5]);
    const result = createKnockoutSampler(
      input({
        legs: [known],
        penalties: { kind: 'forecast', firstTeamWinProbability: probability },
      }),
    )!.sample(random.random);
    expect(result.winnerTeamId).toBe(probability === 0 ? 2 : 1);
    expect(random.calls()).toBe(1);
  });

  it('uses firstTeamId probability even when that team is away', () => {
    const result = createKnockoutSampler(
      input({
        legs: [{ ...known, homeTeamId: 2, awayTeamId: 1 }],
      }),
    )!.sample(() => 0.64);
    expect(result.winnerTeamId).toBe(1);
    expect(result.legs[0]!.homeTeamId).toBe(2);
  });

  it('preserves known regulation scores without RNG or penalty context', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [{ ...known, homeGoals90: 4, awayGoals90: 2 }],
        penalties: null,
      }),
    )!;
    const result = sampler.sample(() => {
      throw new Error('unexpected RNG');
    });
    expect(result.winnerTeamId).toBe(1);
    expect(result.legs[0]!.source).toBe('known-result');
    expect(sampler.fixedLegCount).toBe(1);
    expect(sampler.simulatedLegCount).toBe(0);
    expect(sampler.tailUpperBound).toBe(0);
  });

  it('uses aggregate goals after reversing home order and preserves the first leg', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [
          { ...forecast, leg: 2 },
          { ...known, homeTeamId: 2, awayTeamId: 1, homeGoals90: 0, awayGoals90: 2 },
        ],
      }),
    )!;
    const random = randomFrom([0.05, 0.5]);
    const result = sampler.sample(random.random);
    expect(result.legs.map((leg) => leg.leg)).toEqual([1, 2]);
    expect(result.aggregateGoals90).toEqual({ first: 2, second: 1 });
    expect(result.method).toBe('aggregate-goals');
    expect(result.winnerTeamId).toBe(1);
    expect(result.legs.map((leg) => leg.source)).toEqual([
      'known-result',
      'simulated',
    ]);
    expect(random.calls()).toBe(2);
  });

  it('ignores away-goals counts and goes directly to penalties on an equal aggregate', () => {
    const result = createKnockoutSampler(
      input({
        legs: [
          { ...known, homeGoals90: 1, awayGoals90: 0 },
          {
            ...known,
            leg: 2,
            homeTeamId: 2,
            awayTeamId: 1,
            homeGoals90: 2,
            awayGoals90: 1,
          },
        ],
      }),
    )!.sample(() => 0.9);
    expect(result.aggregateGoals90).toEqual({ first: 2, second: 2 });
    expect(result.method).toBe('penalties');
    expect(result.winnerTeamId).toBe(2);
  });

  it('plays extra time at the second leg venue only after an equal aggregate', () => {
    const random = randomFrom([0.05, 0.5]);
    const result = createKnockoutSampler(
      input({
        legs: [known, { ...known, leg: 2, homeTeamId: 2, awayTeamId: 1 }],
        extraTime: { kind: 'forecast', homeRate30: 1.5, awayRate30: 0.8 },
      }),
    )!.sample(random.random);
    expect(result.aggregateGoals90).toEqual({ first: 2, second: 2 });
    expect(result.extraTime).toEqual({
      homeTeamId: 2,
      awayTeamId: 1,
      homeGoals30: 0,
      awayGoals30: 1,
      source: 'simulated',
    });
    expect(result.aggregateGoalsAfterExtraTime).toEqual({ first: 3, second: 2 });
    expect(result.method).toBe('extra-time-goals');
    expect(result.winnerTeamId).toBe(1);
    expect(result.shootout).toBeNull();
    expect(random.calls()).toBe(2);
  });

  it('draws regulation, then extra time, then the shootout in that order', () => {
    const random = randomFrom([0.9, 0.99, 0.9, 0.99, 0.8]);
    const result = createKnockoutSampler(
      input({
        extraTime: { kind: 'forecast', homeRate30: 1.5, awayRate30: 0.8 },
      }),
    )!.sample(random.random);
    expect(result.aggregateGoals90).toEqual({ first: 3, second: 3 });
    expect(result.aggregateGoalsAfterExtraTime).toEqual({ first: 6, second: 6 });
    expect(result.method).toBe('penalties');
    expect(result.shootout).toEqual({ winnerTeamId: 2, source: 'simulated' });
    expect(random.calls()).toBe(5);
  });

  it('does not generate unused extra time or consume a shootout draw', () => {
    const random = randomFrom([0.05, 0.5]);
    const result = createKnockoutSampler(
      input({
        extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0.2 },
      }),
    )!.sample(random.random);
    expect(result.extraTime).toBeNull();
    expect(result.aggregateGoalsAfterExtraTime).toBeNull();
    expect(result.method).toBe('regulation-goals');
    expect(random.calls()).toBe(2);
  });

  it('preserves completed extra time and shootout without any RNG', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [known],
        extraTime: { kind: 'known-result', homeGoals30: 2, awayGoals30: 2 },
        penalties: { kind: 'known-result', winnerTeamId: 2 },
      }),
    )!;
    const result = sampler.sample(() => {
      throw new Error('unexpected RNG');
    });
    expect(result.extraTime!.source).toBe('known-result');
    expect(result.aggregateGoals90).toEqual({ first: 1, second: 1 });
    expect(result.aggregateGoalsAfterExtraTime).toEqual({ first: 3, second: 3 });
    expect(result.shootout).toEqual({ winnerTeamId: 2, source: 'known-result' });
    expect(result.winnerTeamId).toBe(2);
    expect(sampler.tailUpperBound).toBe(0);
  });

  it('accepts decisive known extra time without penalty context', () => {
    const result = createKnockoutSampler(
      input({
        legs: [known],
        extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 1 },
        penalties: null,
      }),
    )!.sample(() => {
      throw new Error('unexpected RNG');
    });
    expect(result.method).toBe('extra-time-goals');
    expect(result.winnerTeamId).toBe(2);
    expect(result.shootout).toBeNull();
  });

  it('supports mixed completed extra time and a forecast shootout', () => {
    const random = randomFrom([0.1]);
    const result = createKnockoutSampler(
      input({
        legs: [known],
        extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 0 },
      }),
    )!.sample(random.random);
    expect(result.extraTime!.source).toBe('known-result');
    expect(result.shootout!.source).toBe('simulated');
    expect(random.calls()).toBe(1);
  });

  it('sums reachable score tail bounds and excludes known or unreachable stages', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [forecast, { ...forecast, leg: 2, homeTeamId: 2, awayTeamId: 1 }],
        extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0.2 },
      }),
    )!;
    const leg = createPoissonScoreSampler(1.5, 0.8, options)!;
    const extra = createPoissonScoreSampler(0.4, 0.2, options)!;
    expect(sampler.tailUpperBound).toBe(
      2 * leg.tailUpperBound + extra.tailUpperBound,
    );
    const knownWinner = createKnockoutSampler(
      input({
        legs: [{ ...known, homeGoals90: 2 }],
        extraTime: { kind: 'forecast', homeRate30: Number.MAX_VALUE, awayRate30: 0 },
        penalties: null,
      }),
    )!;
    expect(knownWinner.tailUpperBound).toBe(0);
    expect(knownWinner.extraTimePolicy).toBe('extra-time-then-penalties');
    expect(
      knownWinner.sample(() => {
        throw new Error('unexpected RNG');
      }).winnerTeamId,
    ).toBe(1);
  });

  it('caps the per-series union bound at one', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [
          { ...forecast, homeRate90: 0.7, awayRate90: 0 },
          {
            ...forecast,
            leg: 2,
            homeTeamId: 2,
            awayTeamId: 1,
            homeRate90: 0.7,
            awayRate90: 0,
          },
        ],
        extraTime: { kind: 'forecast', homeRate30: 0.7, awayRate30: 0 },
        sampling: { tailTolerance: 0.9, maxGoals: 1 },
      }),
    )!;
    expect(sampler.tailUpperBound).toBe(1);
  });

  it('returns null for missing shootout context without dropping tied scenarios', () => {
    for (const data of [
      input({ penalties: null }),
      input({ legs: [known], penalties: null }),
      input({
        legs: [known],
        extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0.2 },
        penalties: null,
      }),
      input({
        legs: [known],
        extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 0 },
        penalties: null,
      }),
    ])
      expect(createKnockoutSampler(data)).toBeNull();
  });

  it('returns null for unavailable reachable regulation or extra-time samplers', () => {
    expect(
      createKnockoutSampler(
        input({ sampling: { tailTolerance: 1e-10, maxGoals: 0 } }),
      ),
    ).toBeNull();
    expect(
      createKnockoutSampler(
        input({
          legs: [known],
          extraTime: {
            kind: 'forecast',
            homeRate30: Number.MAX_VALUE,
            awayRate30: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it('reproduces results across calls, batches and reversed leg transport order', () => {
    const data = input({
      legs: [forecast, { ...forecast, leg: 2, homeTeamId: 2, awayTeamId: 1 }],
      extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0.2 },
    });
    const a = createKnockoutSampler(data)!;
    const b = createKnockoutSampler({ ...data, legs: [...data.legs].reverse() })!;
    const ra = createSeededRandom([123, 456, 789, 101112]);
    const rb = createSeededRandom([123, 456, 789, 101112]);
    const whole = Array.from({ length: 500 }, () => a.sample(ra));
    const batched = [1, 20, 79, 400].flatMap((length) =>
      Array.from({ length }, () => b.sample(rb)),
    );
    expect(batched).toEqual(whole);
  });

  it('matches independent 100-digit Poisson winner references over fixed samples', () => {
    const examples = [
      {
        data: input({
          extraTime: { kind: 'forecast', homeRate30: 0.4, awayRate30: 0.2 },
        }),
        probability: 0.712552522319951,
      },
      {
        data: input({
          legs: [
            {
              ...forecast,
              homeTeamId: 2,
              awayTeamId: 1,
              homeRate90: 0.7,
              awayRate90: 1.1,
            },
            { ...forecast, leg: 2 },
          ],
        }),
        probability: 0.7288820853840956,
      },
    ];
    for (const { data, probability } of examples) {
      const sampler = createKnockoutSampler(data)!;
      const random = createSeededRandom([123, 456, 789, 101112]);
      let firstWins = 0;
      const runs = 60_000;
      for (let run = 0; run < runs; run += 1)
        if (sampler.sample(random).winnerTeamId === 1) firstWins += 1;
      // Full untruncated references; the declared tail bound is far below
      // the Monte Carlo tolerance. The references do not call this sampler.
      expect(Math.abs(firstWins / runs - probability)).toBeLessThan(0.008);
    }
  });

  it.each(['title', 'survival'] as const)(
    'feeds the real Serie A $0 result resolver',
    (kind) => {
      const legs: KnockoutLegInput[] =
        kind === 'title'
          ? [{ ...forecast, homeRate90: 0, awayRate90: 0 }]
          : [
              { ...known, homeTeamId: 2, awayTeamId: 1 },
              { ...forecast, leg: 2, homeRate90: 0, awayRate90: 0 },
            ];
      const sampled = createKnockoutSampler(input({ legs }))!.sample(() => 0.9);
      const resolved = resolveSerieAPlayOffResult(
        event(kind),
        sampled.legs,
        sampled.shootout,
      )!;
      expect(resolved.method).toBe('penalties');
      expect(resolved.placements.map((row) => row.teamId)).toEqual([2, 1]);
      expect(resolved.legs).toEqual(sampled.legs);
      expect(resolved.shootout).toEqual(sampled.shootout);
    },
  );

  it('copies all inputs and keeps sampled objects independent', () => {
    const leg = { ...forecast };
    const extra = { kind: 'forecast' as const, homeRate30: 0, awayRate30: 0 };
    const penalties = { kind: 'forecast' as const, firstTeamWinProbability: 0.65 };
    const sampling = { ...options, maxGoals: 64 };
    const data = { ...input(), legs: [leg], extraTime: extra, penalties, sampling };
    const sampler = createKnockoutSampler(data)!;
    const baseline = sampler.sample(() => 0);
    leg.homeRate90 = 100;
    leg.homeTeamId = 99;
    extra.homeRate30 = 100;
    penalties.firstTeamWinProbability = 0;
    sampling.maxGoals = 0;
    data.firstTeamId = 99;
    data.legs.splice(0);
    const altered = sampler.sample(() => 0);
    altered.legs[0]!.homeGoals90 = 999;
    altered.aggregateGoals90.first = 999;
    altered.aggregateGoalsAfterExtraTime!.second = 999;
    altered.extraTime!.homeGoals30 = 999;
    altered.shootout!.winnerTeamId = 999;
    expect(sampler.sample(() => 0)).toEqual(baseline);
  });

  it('accepts frozen input and copies completed conditional results', () => {
    const leg = { ...known };
    const extra = { kind: 'known-result' as const, homeGoals30: 0, awayGoals30: 0 };
    const penalties = { kind: 'known-result' as const, winnerTeamId: 1 };
    const sampler = createKnockoutSampler(
      Object.freeze(
        input({
          legs: Object.freeze([Object.freeze(leg)]),
          extraTime: Object.freeze(extra),
          penalties: Object.freeze(penalties),
        }),
      ),
    )!;
    const first = sampler.sample(() => {
      throw new Error('unexpected RNG');
    });
    first.extraTime!.awayGoals30 = 999;
    first.shootout!.winnerTeamId = 999;
    expect(sampler.sample(() => 0).winnerTeamId).toBe(1);
    expect(sampler.sample(() => 0).extraTime!.awayGoals30).toBe(0);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid team ID %s',
    (id) => {
      expect(() => createKnockoutSampler(input({ firstTeamId: id }))).toThrow(
        RangeError,
      );
      expect(() => createKnockoutSampler(input({ secondTeamId: id }))).toThrow(
        RangeError,
      );
    },
  );

  it('rejects identical teams, foreign participants and malformed scheduled legs', () => {
    expect(() => createKnockoutSampler(input({ secondTeamId: 1 }))).toThrow(
      RangeError,
    );
    for (const legs of [
      [],
      [forecast, forecast, forecast],
      [{ ...forecast, leg: 2 }],
      [forecast, { ...forecast, leg: 2 }],
      [forecast, forecast],
      [{ ...forecast, awayTeamId: 3 }],
      [{ ...forecast, awayTeamId: 1 }],
      [undefined],
      Array(1),
      [{ ...forecast, leg: 0 }],
    ])
      expect(() =>
        createKnockoutSampler(input({ legs: legs as KnockoutLegInput[] })),
      ).toThrow(RangeError);
  });

  it.each([-1, 1.1, NaN, Infinity, -Infinity])(
    'rejects invalid shootout probability %s',
    (probability) => {
      expect(() =>
        createKnockoutSampler(
          input({
            penalties: { kind: 'forecast', firstTeamWinProbability: probability },
          }),
        ),
      ).toThrow(RangeError);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid known goals %s in every stage',
    (goals) => {
      for (const field of ['homeGoals90', 'awayGoals90'] as const)
        expect(() =>
          createKnockoutSampler(input({ legs: [{ ...known, [field]: goals }] })),
        ).toThrow(RangeError);
      for (const field of ['homeGoals30', 'awayGoals30'] as const)
        expect(() =>
          createKnockoutSampler(
            input({
              legs: [known],
              extraTime: {
                kind: 'known-result',
                homeGoals30: 0,
                awayGoals30: 0,
                [field]: goals,
              },
            }),
          ),
        ).toThrow(RangeError);
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects invalid rates %s even in unused stages',
    (rate) => {
      expect(() =>
        createKnockoutSampler(input({ legs: [{ ...forecast, awayRate90: rate }] })),
      ).toThrow(RangeError);
      expect(() =>
        createKnockoutSampler(
          input({
            legs: [{ ...known, homeGoals90: 2 }],
            extraTime: { kind: 'forecast', homeRate30: rate, awayRate30: 0 },
          }),
        ),
      ).toThrow(RangeError);
    },
  );

  it('validates every later stage after an unavailable earlier sampler', () => {
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [{ ...forecast, homeRate90: Number.MAX_VALUE }],
          extraTime: { kind: 'forecast', homeRate30: NaN, awayRate30: 0 },
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [{ ...forecast, homeRate90: Number.MAX_VALUE }],
          penalties: { kind: 'forecast', firstTeamWinProbability: NaN },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects observed extra time without completed tied regulation', () => {
    for (const legs of [[forecast], [{ ...known, homeGoals90: 2 }]])
      expect(() =>
        createKnockoutSampler(
          input({
            legs,
            extraTime: { kind: 'known-result', homeGoals30: 0, awayGoals30: 0 },
          }),
        ),
      ).toThrow(RangeError);
  });

  it('rejects an observed shootout without completed tied final totals', () => {
    for (const data of [
      input(),
      input({ legs: [{ ...known, homeGoals90: 2 }] }),
      input({
        legs: [known],
        extraTime: { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
      }),
      input({
        legs: [known],
        extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 0 },
      }),
    ])
      expect(() =>
        createKnockoutSampler({
          ...data,
          penalties: { kind: 'known-result', winnerTeamId: 1 },
        }),
      ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [known],
          penalties: { kind: 'known-result', winnerTeamId: 99 },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects unsafe known aggregate or extra-time additions before sampling', () => {
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [
            { ...known, homeGoals90: Number.MAX_SAFE_INTEGER, awayGoals90: 0 },
            {
              ...known,
              leg: 2,
              homeTeamId: 2,
              awayTeamId: 1,
              homeGoals90: 0,
              awayGoals90: 1,
            },
          ],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [
            {
              ...known,
              homeGoals90: Number.MAX_SAFE_INTEGER,
              awayGoals90: Number.MAX_SAFE_INTEGER,
            },
          ],
          extraTime: { kind: 'known-result', homeGoals30: 1, awayGoals30: 0 },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('throws instead of clipping an unsafe sampled aggregate', () => {
    const sampler = createKnockoutSampler(
      input({
        legs: [
          { ...known, homeGoals90: Number.MAX_SAFE_INTEGER, awayGoals90: 0 },
          { ...forecast, leg: 2, homeTeamId: 2, awayTeamId: 1 },
        ],
      }),
    )!;
    expect(() => sampler.sample(() => 0.5)).toThrow(RangeError);
  });

  it.each([-1, 1, NaN, Infinity, -Infinity])(
    'rejects random value %s in regulation, extra time and penalties',
    (uniform) => {
      const configurations = [
        input(),
        input({
          legs: [known],
          extraTime: { kind: 'forecast', homeRate30: 0, awayRate30: 0 },
        }),
        input({ legs: [known] }),
      ];
      for (const data of configurations)
        expect(() => createKnockoutSampler(data)!.sample(() => uniform)).toThrow(
          RangeError,
        );
    },
  );

  it('validates sampling options for completed games as well', () => {
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [known],
          sampling: { tailTolerance: 1, maxGoals: 0 },
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [known],
          sampling: { tailTolerance: 1e-10, maxGoals: -1 },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects unclassified stages instead of inventing a format', () => {
    expect(() =>
      createKnockoutSampler(
        input({
          extraTime: {
            kind: 'unknown',
          } as unknown as KnockoutSamplingInput['extraTime'],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          penalties: {
            kind: 'unknown',
          } as unknown as KnockoutSamplingInput['penalties'],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      createKnockoutSampler(
        input({
          legs: [{ ...forecast, kind: 'unknown' } as unknown as KnockoutLegInput],
        }),
      ),
    ).toThrow(RangeError);
  });
});
