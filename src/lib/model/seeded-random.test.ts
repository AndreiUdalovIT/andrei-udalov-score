import { describe, expect, it } from 'vitest';

import {
  createSeededRandom,
  SEEDED_RANDOM_ALGORITHM,
  type RandomSeed,
} from './seeded-random';

const scale = 2 ** 53;

// Integer numerators generated independently with the authors' C engine.
// Each sample combines the highest 27 bits of one output and 26 of the next.
const referenceCases: readonly {
  seed: RandomSeed;
  first: readonly number[];
  tenThousandth: number;
}[] = [
  {
    seed: [1, 2, 3, 4],
    first: [
      24159191040, 12429904896630, 4260829579335916, 2699535918462416,
      7820490797693033, 708478846817104, 7501315636611796, 8116477746924511,
    ],
    tenThousandth: 8662956757356706,
  },
  {
    seed: [0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff],
    first: [
      9007189591064503, 9001016850690982, 3166581412253606, 5623315649913948,
      2209252739809760, 3876490191978415, 7341939204764481, 1323282319319736,
    ],
    tenThousandth: 5470622684159705,
  },
  {
    seed: [0, 0, 0, 1],
    first: [
      0, 12079779930, 5660435380483252, 3503768688638978, 7456799447854721,
      7127394855950685, 8078141043978740, 899855759356842,
    ],
    tenThousandth: 4455956674135408,
  },
  {
    seed: [0x8000_0000, 0x0123_4567, 0x89ab_cdef, 0xfedc_ba98],
    first: [
      5404313123815378, 5391917244194830, 5968421912683854, 8667155484583695,
      4008634642403060, 387021105072494, 5272824706663793, 5034231440359651,
    ],
    tenThousandth: 1051854977973673,
  },
];

describe('versioned seeded simulation random numbers', () => {
  it('identifies both the engine and the 53-bit conversion', () => {
    expect(SEEDED_RANDOM_ALGORITHM).toBe('xoshiro128ss-1.1-u53-v1');
  });

  it.each(referenceCases)('matches the C reference for seed $seed', (reference) => {
    const random = createSeededRandom(reference.seed);
    const first = reference.first.map(() => random() * scale);
    expect(first).toEqual(reference.first);

    for (let index = first.length; index < 9999; index += 1) random();
    expect(random() * scale).toBe(reference.tenThousandth);
  });

  it('reproduces independent interleaved instances after JSON transport', () => {
    const seed = Object.freeze([123, 456, 789, 101112] as const);
    const transported: RandomSeed = JSON.parse(JSON.stringify(seed));
    const first = createSeededRandom(seed);
    const second = createSeededRandom(transported);
    const unrelated = createSeededRandom([7, 8, 9, 10]);

    for (let index = 0; index < 1000; index += 1) {
      unrelated();
      expect(first()).toBe(second());
    }
    expect(seed).toEqual([123, 456, 789, 101112]);
  });

  it('copies the input seed instead of retaining mutable caller state', () => {
    const seed: [number, number, number, number] = [1, 2, 3, 4];
    const random = createSeededRandom(seed);
    seed.fill(0);
    expect(random() * scale).toBe(referenceCases[0]!.first[0]);
  });

  it('supports zero and the largest representable sample below one', () => {
    expect(createSeededRandom([1, 0, 1, 0])()).toBe(0);
    expect(createSeededRandom([0, 2199679431, 0, 0])()).toBe(1 - 1 / scale);
  });

  it('returns finite 53-bit fractions in [0, 1) over a long stream', () => {
    const random = createSeededRandom([123, 456, 789, 101112]);
    for (let index = 0; index < 100_000; index += 1) {
      const value = random();
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value >= 1 ||
        !Number.isSafeInteger(value * scale)
      ) {
        throw new Error(`invalid sample at index ${index}: ${value}`);
      }
    }
  });

  it.each(
    [[], [1], [1, 2, 3], [1, 2, 3, 4, 5], [0, 0, 0, 0], Array(4)].map((seed) => ({
      seed,
    })),
  )('rejects an incomplete, oversized or all-zero seed $seed', ({ seed }) => {
    expect(() => createSeededRandom(seed as unknown as RandomSeed)).toThrow(
      RangeError,
    );
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER])(
    'rejects the invalid word %s in every position',
    (word) => {
      for (let index = 0; index < 4; index += 1) {
        const seed: [number, number, number, number] = [1, 2, 3, 4];
        seed[index] = word;
        expect(() => createSeededRandom(seed)).toThrow(RangeError);
      }
    },
  );
});
