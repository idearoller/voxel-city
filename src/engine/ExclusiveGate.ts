/**
 * Guards a set of async operations so at most one of them is ever running at
 * once — an early-return re-entrancy guard, not a queue: a call that arrives
 * while another is still in flight is simply dropped rather than deferred or
 * run concurrently. No Three.js, no DOM; pure enough to unit-test with a
 * hand-controlled promise instead of a real async operation.
 *
 * `main.ts` uses one shared instance across `runGeneration` and
 * `importCity`: both rebuild the same `World`/`EntitySystem`/environment
 * probe, and generation's own `await chunkRenderer.flushPending()` can take
 * many animation frames — long enough that a user mashing "Generate" (or
 * Generate then Import) mid-flush would otherwise kick off a second run
 * while the first is still touching the same state, doubling up on
 * `entitySystem.rebuild`/`refreshEnvironmentProbe` and racing writes to
 * `world`.
 */
export class ExclusiveGate {
  private running = false;

  /** True while a guarded operation is in flight. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Runs `operation` unless one is already in flight, in which case this call is a no-op. */
  async run(operation: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await operation();
    } finally {
      this.running = false;
    }
  }
}
