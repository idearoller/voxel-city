import { describe, expect, it } from 'vitest';
import { ExclusiveGate } from '../src/engine/ExclusiveGate';

/** A promise plus its resolver, so a test can control exactly when a guarded operation finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ExclusiveGate', () => {
  it('runs a single operation to completion', async () => {
    const gate = new ExclusiveGate();
    let ran = 0;

    await gate.run(async () => {
      ran++;
    });

    expect(ran).toBe(1);
    expect(gate.isRunning).toBe(false);
  });

  it('drops a second call that arrives while the first is still in flight', async () => {
    const gate = new ExclusiveGate();
    const first = deferred();
    let firstStarts = 0;
    let secondStarts = 0;

    const firstRun = gate.run(async () => {
      firstStarts++;
      await first.promise;
    });
    expect(gate.isRunning).toBe(true);

    // Arrives mid-flight -- must be a no-op, not queued and not concurrent.
    const secondRun = gate.run(async () => {
      secondStarts++;
    });

    first.resolve();
    await firstRun;
    await secondRun;

    expect(firstStarts).toBe(1);
    expect(secondStarts).toBe(0);
    expect(gate.isRunning).toBe(false);
  });

  it('allows a fresh call once the in-flight operation has finished', async () => {
    const gate = new ExclusiveGate();
    let ran = 0;

    await gate.run(async () => {
      ran++;
    });
    await gate.run(async () => {
      ran++;
    });

    expect(ran).toBe(2);
  });

  it('clears the running flag even if the operation throws', async () => {
    const gate = new ExclusiveGate();

    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(gate.isRunning).toBe(false);
    let ranAfter = false;
    await gate.run(async () => {
      ranAfter = true;
    });
    expect(ranAfter).toBe(true);
  });
});
