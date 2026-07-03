/**
 * Deterministic PRNG for procedural generation. mulberry32 core + a string
 * seed hash, wrapped in a small `Rng` class that adds float/int/chance/pick
 * helpers and `fork()` for independent, reproducible sub-streams.
 *
 * No Three.js dependency — pure math, unit-testable in isolation.
 */

export type RandomFn = () => number;

/** FNV-1a string hash -> uint32. Used to turn a human seed string into a numeric PRNG seed. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

/** mulberry32: fast, small-state PRNG producing floats in [0, 1). */
function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic random stream with convenience helpers.
 *
 * `fork(label)` derives a new independent stream from this stream's
 * *original* seed and the label — not from however many numbers have
 * already been drawn — so a given (seed, label) pair always reproduces the
 * same sub-stream regardless of call order or how much of the parent stream
 * was consumed first.
 */
export class Rng {
  private readonly next: RandomFn;

  constructor(private readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** Next raw float in [0, 1). */
  random(): number {
    return this.next();
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] (both inclusive). */
  intRange(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  /** True with the given probability in [0, 1]. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Uniformly picks one element from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick: cannot pick from an empty array');
    }
    return items[this.intRange(0, items.length - 1)] as T;
  }

  /** Derives an independent, deterministic sub-stream identified by `label`. */
  fork(label: string): Rng {
    return new Rng(hashString(`${this.seed}:${label}`));
  }

  /**
   * This stream's raw numeric seed. Exposed for generators that need a
   * stable numeric key rather than sequential draws — e.g. value noise,
   * which must hash arbitrary (x, z) lattice points on demand rather than
   * consuming a linear sequence, so it can't use `random()`/`fork()`.
   */
  hashSeed(): number {
    return this.seed;
  }
}

/** Creates a root Rng from a string or numeric seed. */
export function createRng(seed: string | number): Rng {
  const numericSeed = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return new Rng(numericSeed);
}
