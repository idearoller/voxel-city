/**
 * Pure logic behind the positional hover-car flyby effect — no WebAudio, no
 * DOM, no entity types. This is the layer Sam's quality bar cares most
 * about: nearest-N voice assignment (with continuity/hysteresis), the
 * distance -> gain falloff, the pan computation, and the radial-speed ->
 * filter mapping are all plain functions over plain numbers, so every rule
 * is unit-testable without spinning up a fake `AudioContext`.
 *
 * `FlybyGraph.ts` is the only caller: it owns the actual WebAudio voice pool
 * and pushes whatever this module computes onto each voice's `AudioParam`s
 * every tick via `setTargetAtTime`. `AudioSystem`/`EntitySystem`/`main.ts`
 * own the data flow that gets a `FlyerRelativeState[]` here in the first
 * place (see `types.ts`'s doc comment on that DTO for why it's plain data
 * rather than an entity reference).
 *
 * Voice assignment (`assignFlybyVoices`) is the one piece worth explaining
 * up front: naively re-picking the nearest N flyers every frame works fine
 * *until* two flyers hover at nearly equal distance right at the voice-pool
 * boundary — then whichever one is marginally closer flips frame to frame,
 * "chattering" a shared voice slot between two different vehicles (a click
 * or a pan/pitch jump every tick). Fixed by tracking continuity instead:
 * each slot's *previous* target position is matched against the closest
 * current flyer near that same spot first, and only falls back to strict
 * nearest-first ranking for slots that come up empty (occupant left
 * audibility, or a completely new flyer entered). Because flying vehicles
 * move continuously (see `FlyingVehicle.ts` — no teleporting, only
 * `stepFlyingVehicle`'s per-tick integration), a real occupant's position
 * this frame is always within `CONTINUITY_MAX_JUMP` of where it was last
 * frame, so this match is unambiguous and never mistakes a genuine
 * hand-off for jitter.
 */

export interface FlyerRelativeState {
  dx: number;
  dy: number;
  dz: number;
  vx: number;
  vz: number;
}

export interface ListenerRight {
  x: number;
  z: number;
}

export interface FlybyVoiceTarget {
  /** Linear gain, already folding in distance falloff and the approach boost — 0 means "silent, don't bother being heard". */
  gain: number;
  /** Stereo position in [-1, 1]; -1 = full left, +1 = full right. */
  pan: number;
  /** Bandpass center frequency (Hz) for the voice's filtered-noise source. */
  filterHz: number;
}

/** Fixed voice-pool size — see `FlybyGraph.ts`. Four is enough for the busiest realistic case (a couple of sky lanes crossing near the player) without competing for attention with the ambient traffic bed. */
export const FLYBY_VOICE_COUNT = 4;

/** Hard audibility cutoff, in meters. Chosen well below the entity system's despawn radius (110, see `EntitySimulationConfig`) and comfortably below sky-lane altitude (104+) above street level — an ordinary overhead pass in play mode is naturally silent (its 3D distance, altitude included, exceeds this), while a sandbox/fly-mode flyer hovering near the lane falls well inside it. */
export const FLYBY_AUDIBLE_RADIUS = 50;
/** Distance inside which the falloff curve saturates to its peak — comfortably outside "inside the vehicle's own body" (a couple voxels) so gain never spikes on a near-zero denominator. */
const FLYBY_NEAR_DISTANCE = 4;
/** Peak linear gain at `FLYBY_NEAR_DISTANCE`, before the approach boost — conservative next to the ambient traffic bed's own peak (`TRAFFIC_BASE_GAIN` = 0.09 in `AudioGraph.ts`), since this is a foreground event layered on top, not a fourth ambient bus. */
const FLYBY_PEAK_GAIN = 0.22;
/** Extra fractional gain at max approach speed — accents a fast close pass without ever doubling the base curve. */
const FLYBY_APPROACH_GAIN_BOOST = 0.3;

/** Bandpass center frequency at zero radial speed. */
const FLYBY_FILTER_BASE_HZ = 900;
/** How far the center frequency swings at saturating radial speed, in either direction. */
const FLYBY_FILTER_SWING_HZ = 600;
/** Radial speed (m/s) at which both the gain boost and filter swing saturate — matches the fastest cruise speed in `flyingVehicleSpeedRange` (see `EntitySimulation.ts`), so an ordinary fast pass reaches full character rather than clipping well short of it. */
const FLYBY_SPEED_NORM = 20;

/** A slot's previous occupant may have moved at most this many meters in one tick before it's treated as a different vehicle claiming the slot — generous headroom over the fastest possible per-tick displacement (`FLYBY_SPEED_NORM` m/s at a worst-case multi-frame stall), so it only ever fires on an actual hand-off, never on ordinary motion. */
const CONTINUITY_MAX_JUMP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** 3D distance from the listener to the flyer. */
export function distanceOf(flyer: FlyerRelativeState): number {
  return Math.hypot(flyer.dx, flyer.dy, flyer.dz);
}

/**
 * Distance -> gain falloff (eased, not linear, so the last few meters of a
 * close pass swell rather than crossing the whole range uniformly), plus a
 * modest boost that only ever fires on *approach* — a receding flyer just
 * follows the plain distance curve, so a pass reads as "arriving" more
 * emphatically than "leaving".
 */
export function computeFlybyGain(distance: number, radialSpeed: number): number {
  if (distance >= FLYBY_AUDIBLE_RADIUS) return 0;
  const t = clamp01((FLYBY_AUDIBLE_RADIUS - distance) / (FLYBY_AUDIBLE_RADIUS - FLYBY_NEAR_DISTANCE));
  const distanceFactor = t * t;
  const approachBoost = 1 + FLYBY_APPROACH_GAIN_BOOST * clamp01(radialSpeed / FLYBY_SPEED_NORM);
  return FLYBY_PEAK_GAIN * distanceFactor * approachBoost;
}

/**
 * Stereo pan from the flyer's horizontal offset projected onto the
 * listener's right axis — i.e. how far left/right of straight-ahead it
 * sits, regardless of whether it's in front of or behind the listener (a
 * flyer dead ahead and one directly behind, at the same left/right offset,
 * share a pan value; stereo alone can't tell them apart, which is fine for
 * an ambient-layer effect like this).
 */
export function computePan(flyer: FlyerRelativeState, right: ListenerRight): number {
  const horizontalDistance = Math.hypot(flyer.dx, flyer.dz);
  if (horizontalDistance < 1e-3) return 0;
  const lateral = (flyer.dx * right.x + flyer.dz * right.z) / horizontalDistance;
  return clamp(lateral, -1, 1);
}

/** Positive = closing distance (approaching), negative = opening distance (receding), zero for purely tangential motion (a flyer crossing at constant range). */
export function computeRadialSpeed(flyer: FlyerRelativeState): number {
  const distance = distanceOf(flyer);
  if (distance < 1e-3) return 0;
  return -(flyer.dx * flyer.vx + flyer.dz * flyer.vz) / distance;
}

/**
 * Center-frequency sweep standing in for real Doppler shift: brighter
 * (higher cutoff) on approach, darker on recession. Cheap and reads as
 * "pitch bending through the pass" without touching playback rate.
 */
export function computeFilterHz(radialSpeed: number): number {
  const t = clamp(radialSpeed / FLYBY_SPEED_NORM, -1, 1);
  return FLYBY_FILTER_BASE_HZ + t * FLYBY_FILTER_SWING_HZ;
}

export function computeVoiceTarget(flyer: FlyerRelativeState, right: ListenerRight): FlybyVoiceTarget {
  const radialSpeed = computeRadialSpeed(flyer);
  return {
    gain: computeFlybyGain(distanceOf(flyer), radialSpeed),
    pan: computePan(flyer, right),
    filterHz: computeFilterHz(radialSpeed),
  };
}

/**
 * Maps each voice slot to an index into `current` (or `null` if the slot
 * should fall silent this frame), preferring continuity with `previous`
 * over strict nearest-first ranking. See the module doc comment for why.
 */
export function assignFlybyVoices(
  previous: readonly (FlyerRelativeState | null)[],
  current: readonly FlyerRelativeState[],
): (number | null)[] {
  const claimed = new Array<boolean>(current.length).fill(false);
  const assignment: (number | null)[] = new Array(previous.length).fill(null);

  // Pass 1: honor continuity -- a slot's previous occupant keeps its slot
  // if the closest unclaimed current flyer to that position is still
  // plausibly the same vehicle (small jump, still in radius).
  for (let slot = 0; slot < previous.length; slot++) {
    const prior = previous[slot];
    if (!prior) continue;

    let bestIndex = -1;
    let bestJump = Infinity;
    for (let i = 0; i < current.length; i++) {
      if (claimed[i]) continue;
      const candidate = current[i]!;
      const jump = Math.hypot(candidate.dx - prior.dx, candidate.dy - prior.dy, candidate.dz - prior.dz);
      if (jump < bestJump) {
        bestJump = jump;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestJump <= CONTINUITY_MAX_JUMP && distanceOf(current[bestIndex]!) < FLYBY_AUDIBLE_RADIUS) {
      assignment[slot] = bestIndex;
      claimed[bestIndex] = true;
    }
  }

  // Pass 2: fill any still-empty slots with the closest unclaimed,
  // in-radius flyers left over (a departed occupant, or a brand new slot).
  const remaining: number[] = [];
  for (let i = 0; i < current.length; i++) {
    if (!claimed[i] && distanceOf(current[i]!) < FLYBY_AUDIBLE_RADIUS) remaining.push(i);
  }
  remaining.sort((a, b) => distanceOf(current[a]!) - distanceOf(current[b]!));

  let nextRemaining = 0;
  for (let slot = 0; slot < assignment.length; slot++) {
    if (assignment[slot] !== null) continue;
    if (nextRemaining < remaining.length) {
      assignment[slot] = remaining[nextRemaining]!;
      nextRemaining++;
    }
  }

  return assignment;
}
