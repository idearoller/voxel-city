import { describe, expect, it } from 'vitest';
import { createRng, hashString } from '../src/gen/rng';

function sequence(count: number, seed: string | number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.random());
}

describe('hashString', () => {
  it('is deterministic for the same input', () => {
    expect(hashString('city-42')).toBe(hashString('city-42'));
  });

  it('differs for different inputs', () => {
    expect(hashString('city-42')).not.toBe(hashString('city-43'));
  });
});

describe('createRng determinism', () => {
  it('produces the same sequence for the same string seed', () => {
    expect(sequence(20, 'neo-tokyo')).toEqual(sequence(20, 'neo-tokyo'));
  });

  it('produces the same sequence for the same numeric seed', () => {
    expect(sequence(20, 12345)).toEqual(sequence(20, 12345));
  });

  it('produces different sequences for different seeds', () => {
    expect(sequence(20, 'seed-a')).not.toEqual(sequence(20, 'seed-b'));
  });

  it('all values lie in [0, 1)', () => {
    for (const value of sequence(500, 'range-check')) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('Rng.fork', () => {
  it('is deterministic: same seed + label -> same sub-stream', () => {
    const a = createRng('city').fork('buildings');
    const b = createRng('city').fork('buildings');
    expect(Array.from({ length: 10 }, () => a.random())).toEqual(
      Array.from({ length: 10 }, () => b.random()),
    );
  });

  it('different labels from the same parent produce independent streams', () => {
    const parent = createRng('city');
    const buildings = parent.fork('buildings');
    const layout = parent.fork('layout');
    expect(Array.from({ length: 10 }, () => buildings.random())).not.toEqual(
      Array.from({ length: 10 }, () => layout.random()),
    );
  });

  it('is independent of how much the parent stream was consumed first', () => {
    const untouched = createRng('city').fork('buildings');

    const consumedParent = createRng('city');
    consumedParent.random();
    consumedParent.random();
    consumedParent.random();
    const afterConsumption = consumedParent.fork('buildings');

    expect(Array.from({ length: 10 }, () => untouched.random())).toEqual(
      Array.from({ length: 10 }, () => afterConsumption.random()),
    );
  });
});

describe('Rng helpers', () => {
  it('float(min, max) stays within [min, max)', () => {
    const rng = createRng('helpers-float');
    for (let i = 0; i < 200; i++) {
      const value = rng.float(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(9);
    }
  });

  it('intRange(min, max) is an integer within [min, max] inclusive', () => {
    const rng = createRng('helpers-int');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const value = rng.intRange(1, 3);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it('chance(1) is always true and chance(0) is always false', () => {
    const rng = createRng('helpers-chance');
    for (let i = 0; i < 50; i++) {
      expect(rng.chance(1)).toBe(true);
      expect(rng.chance(0)).toBe(false);
    }
  });

  it('pick only returns elements from the given array', () => {
    const rng = createRng('helpers-pick');
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it('pick throws on an empty array', () => {
    const rng = createRng('helpers-pick-empty');
    expect(() => rng.pick([])).toThrow();
  });
});
