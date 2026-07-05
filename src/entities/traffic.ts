/**
 * Same-lane follow-the-leader spacing, shared by ground (`Vehicle`) and
 * flying (`FlyingVehicle`) traffic. This module only handles the
 * direction-agnostic math (lane grouping/ordering, target-speed shaping,
 * smoothed acceleration) — it knows nothing about `x`/`z`/`cellX` or how a
 * given entity type maps its own state onto a lane. Each entity type
 * combines these primitives with its own `laneKey`/`travelPos` accessors
 * (see `applyVehicleFollowSpacing` in `Vehicle.ts` and
 * `applyFlyingVehicleFollowSpacing` in `FlyingVehicle.ts`).
 *
 * Deliberately NOT modeling oncoming/cross-lane traffic: both call sites
 * key lanes by direction as well as lane identity, so an opposite-direction
 * or different-lane entity never contributes a leader/follower relationship
 * here in the first place — see this task's design note for why (ground
 * lanes are directional per column/row; sky lanes are keyed by direction
 * too, since two hover-cars flying toward each other on the same physical
 * corridor are an existing, separately-scoped behavior, not something this
 * follow-distance feature is meant to touch).
 */

export interface LaneMember {
  /** Identifies the 1D corridor + direction of travel this entity currently occupies. Only entities sharing the exact same key can be leader/follower of one another. */
  laneKey: string;
  /** Signed position along the lane's direction of travel: increases as the entity moves forward, whatever world axis/sign that maps to for its actual type. */
  travelPos: number;
}

/**
 * Groups `members` by `laneKey` and orders each group ascending by
 * `travelPos` (most-behind first). Returns:
 * - `leaderIndex[i]`: the array index (into `members`) of whatever is
 *   immediately ahead of `members[i]` in its lane, or `-1` if `members[i]`
 *   is the frontmost entity in its lane (nothing to follow).
 * - `order`: every index, ordered so a leader always appears before any of
 *   its followers — callers that need to fold a hard-separation correction
 *   down the chain (a follower's clamp depends on its leader's *final*,
 *   already-corrected position) can safely iterate `order` in sequence.
 *
 * O(n log n): one grouping pass plus a per-lane sort, never all-pairs.
 */
export function computeFollowOrder(members: readonly LaneMember[]): {
  leaderIndex: Int32Array;
  order: number[];
} {
  const n = members.length;
  const leaderIndex = new Int32Array(n).fill(-1);
  const order: number[] = new Array(n);

  const lanes = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = (members[i] as LaneMember).laneKey;
    let indices = lanes.get(key);
    if (!indices) {
      indices = [];
      lanes.set(key, indices);
    }
    indices.push(i);
  }

  let cursor = 0;
  for (const indices of lanes.values()) {
    // Ascending travelPos: indices[0] is rearmost, indices[last] is frontmost.
    indices.sort((a, b) => (members[a] as LaneMember).travelPos - (members[b] as LaneMember).travelPos);
    for (let rank = indices.length - 1; rank >= 0; rank--) {
      const idx = indices[rank] as number;
      order[cursor++] = idx; // front-to-back, so a leader is always emitted before its follower
      if (rank > 0) leaderIndex[indices[rank - 1] as number] = idx; // the one just behind follows this one
    }
  }

  return { leaderIndex, order };
}

/**
 * Target speed for a follower given the gap to its leader: full cruise
 * speed once the gap clears `followDistance`, ramping linearly down to a
 * dead stop as the gap closes to `minSeparation` (clamped at 0, never
 * negative — a gap that's already tighter than `minSeparation` is a job for
 * the caller's hard position clamp, not this function). Never targets
 * faster than the leader itself, so a follower can't out-accelerate its way
 * into the leader it's supposed to be yielding to.
 */
export function followTargetSpeed(
  gap: number,
  cruiseSpeed: number,
  leaderSpeed: number,
  minSeparation: number,
  followDistance: number,
): number {
  if (gap >= followDistance) return cruiseSpeed;
  const capped = Math.min(cruiseSpeed, leaderSpeed);
  if (gap <= minSeparation) return 0;
  const t = (gap - minSeparation) / (followDistance - minSeparation);
  return capped * t;
}

/** Steps `current` toward `desired`, capped by `maxDelta` — smooth accel/decel instead of an instantaneous speed change. */
export function approachSpeed(current: number, desired: number, maxDelta: number): number {
  if (current < desired) return Math.min(current + maxDelta, desired);
  if (current > desired) return Math.max(current - maxDelta, desired);
  return current;
}
