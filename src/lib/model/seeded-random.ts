/** Four unsigned 32-bit words; the all-zero state is forbidden. */
export type RandomSeed = readonly [number, number, number, number];

/** Identifies the engine and the conversion used by persisted simulations. */
export const SEEDED_RANDOM_ALGORITHM = 'xoshiro128ss-1.1-u53-v1';

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/**
 * xoshiro128** 1.1 by David Blackman and Sebastiano Vigna (public domain):
 * https://prng.di.unimi.it/xoshiro128starstar.c
 *
 * Copies the seed and returns numbers k / 2^53 in [0, 1). Each sample consumes
 * two engine outputs: their highest 27 and 26 bits, respectively.
 * Reproduction requires the same seed, algorithm version and draw order.
 * This generator is intended for simulations, not for secrets.
 */
export function createSeededRandom(seed: RandomSeed): () => number {
  if (
    seed.length !== 4 ||
    Array.from(seed).some(
      (word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff,
    ) ||
    seed.every((word) => word === 0)
  ) {
    throw new RangeError(
      'seed must contain four unsigned 32-bit integers and must not be all zero',
    );
  }

  let [s0, s1, s2, s3] = seed;

  function nextUint32(): number {
    const result = Math.imul(rotateLeft(Math.imul(s1, 5), 7), 9) >>> 0;
    const shifted = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= shifted;
    s3 = rotateLeft(s3, 11);
    return result;
  }

  return () => {
    const high = nextUint32() >>> 5;
    const low = nextUint32() >>> 6;
    return (high * 2 ** 26 + low) / 2 ** 53;
  };
}
