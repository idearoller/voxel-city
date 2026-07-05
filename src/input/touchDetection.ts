/**
 * Capability-based touch detection — checks for actual touch support rather
 * than user-agent sniffing, so it also recognizes touch-capable hybrid
 * devices (e.g. a touchscreen laptop) that a UA string wouldn't reveal, and
 * never misfires on a desktop browser spoofing a mobile UA.
 */

export interface TouchCapabilityEnv {
  readonly hasOntouchstart: boolean;
  readonly maxTouchPoints: number;
}

/** Pure predicate — takes its inputs explicitly so it's testable without a real `window`/`navigator`. */
export function hasTouchCapability(env: TouchCapabilityEnv): boolean {
  return env.hasOntouchstart || env.maxTouchPoints > 0;
}

/**
 * Real-environment wrapper. Only call this from browser wiring code (e.g.
 * `main.ts`) — tests should exercise `hasTouchCapability` directly instead.
 * Returns `false` outside a browser (SSR/build tooling), same guard style as
 * the `typeof window !== 'undefined'` checks in `player/`.
 */
export function detectTouchCapability(): boolean {
  if (typeof window === 'undefined') return false;
  return hasTouchCapability({
    hasOntouchstart: 'ontouchstart' in window,
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  });
}
