/**
 * Fixed-timestep accumulator arithmetic, extracted from `Engine.tick` so it
 * can be unit-tested without a `window`/WebGL context (see `Engine.ts`'s
 * class doc for why the class itself has no tests).
 */

/** Simulation cadence: `update()` always advances the world by this much. */
export const FIXED_TIMESTEP = 1 / 60;

/**
 * Hard ceiling on catch-up `update()` calls per rendered frame.
 *
 * Without this cap, a slow frame (thermal throttling, a GC pause, the tab
 * regaining focus after being backgrounded) hands the accumulator a large
 * backlog, and the naive "while (accumulator >= FIXED_TIMESTEP)" loop pays
 * it all back in one frame: up to 15 `update()` calls (elevator sim,
 * collision, atmosphere, rain, entity simulation) stacked behind a single
 * render. That extra CPU work is exactly what a machine already thermal
 * throttling under GPU load can't absorb -- it compounds the slowdown that
 * caused the backlog in the first place.
 *
 * Capping at 4 steps/frame bounds worst-case sim CPU per frame to roughly
 * once again what steady state costs (4x, not 15x), and trades the
 * alternative failure mode deliberately: under sustained overload, sim time
 * falls behind wall-clock time (the game runs in slow motion) instead of
 * CPU usage spiraling. For a single-player sandbox game, a slower clock is
 * the correct tradeoff against a seized machine.
 */
export const MAX_STEPS_PER_FRAME = 4;

export interface FixedStepResult {
  /** Number of `update(FIXED_TIMESTEP)` calls to run this frame. */
  steps: number;
  /** Accumulator value to carry into the next frame. */
  accumulator: number;
}

/**
 * Given the leftover accumulator from the previous frame and the elapsed
 * time this frame, returns how many fixed steps to run and the accumulator
 * to carry forward.
 *
 * Below the cap this is exact accumulator arithmetic: `steps` fixed steps
 * are consumed and the sub-step remainder (always < `FIXED_TIMESTEP`)
 * carries over, identical to the original `while` loop.
 *
 * At or beyond the cap, the backlog beyond `MAX_STEPS_PER_FRAME` steps is
 * dropped rather than carried: the returned accumulator is reset to 0, not
 * the true (much larger) remainder. Carrying that remainder would just
 * defer the same catch-up burst to the next frame -- dropping it is what
 * actually keeps sim CPU bounded under sustained overload.
 */
export function computeFixedSteps(accumulator: number, frameDelta: number): FixedStepResult {
  const total = accumulator + frameDelta;
  const rawSteps = Math.floor(total / FIXED_TIMESTEP);

  if (rawSteps <= MAX_STEPS_PER_FRAME) {
    return { steps: rawSteps, accumulator: total - rawSteps * FIXED_TIMESTEP };
  }

  return { steps: MAX_STEPS_PER_FRAME, accumulator: 0 };
}
