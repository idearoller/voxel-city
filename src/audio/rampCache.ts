/**
 * Skips a redundant `setTargetAtTime` call when the newly requested target
 * hasn't meaningfully changed since the last one this cache actually issued.
 * `setTargetAtTime` is an exponential *approach* toward its target — once a
 * param is already ramping toward T, re-issuing the same T is an inaudible
 * no-op that only adds another automation event to the context's timeline.
 * With `AudioSystem.update` (3 params) and `FlybyVoicePool.update` (up to 3
 * params per voice, several voices) both re-issuing every fixed tick even
 * when nothing changed, this was ~900 automation events/s running forever
 * (see PERF.md).
 *
 * Deliberately tracks the last *issued* target, not the param's current
 * (possibly still mid-ramp) value: a target that's genuinely changed is
 * never skipped just because the previous ramp toward the *old* target
 * hasn't finished settling yet. Skipping only ever compares the new target
 * against what was last handed to `setTargetAtTime` for this exact param.
 */
export class RampTargetCache {
  private lastIssued: number | null = null;

  constructor(private readonly epsilon: number) {}

  /** Calls `issue(target)` unless `target` is within `epsilon` of the last target this cache actually issued. */
  set(target: number, issue: (target: number) => void): void {
    if (this.lastIssued !== null && Math.abs(target - this.lastIssued) <= this.epsilon) return;
    this.lastIssued = target;
    issue(target);
  }
}
