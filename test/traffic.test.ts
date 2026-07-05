import { describe, expect, it } from 'vitest';
import { approachSpeed, computeFollowOrder, followTargetSpeed, type LaneMember } from '../src/entities/traffic';

describe('computeFollowOrder', () => {
  it('gives every member of a solo lane no leader', () => {
    const members: LaneMember[] = [{ laneKey: 'a', travelPos: 0 }];
    const { leaderIndex } = computeFollowOrder(members);
    expect(Array.from(leaderIndex)).toEqual([-1]);
  });

  it('orders a two-member lane so the one further along is the leader', () => {
    // Index 0 is behind (travelPos 0), index 1 is ahead (travelPos 10).
    const members: LaneMember[] = [
      { laneKey: 'lane', travelPos: 0 },
      { laneKey: 'lane', travelPos: 10 },
    ];
    const { leaderIndex, order } = computeFollowOrder(members);
    expect(leaderIndex[1]).toBe(-1); // frontmost has no leader
    expect(leaderIndex[0]).toBe(1); // the trailing one follows the frontmost
    expect(order).toEqual([1, 0]); // leader processed before follower
  });

  it('never lets travelPos ordering be confused by array insertion order', () => {
    const members: LaneMember[] = [
      { laneKey: 'lane', travelPos: 50 },
      { laneKey: 'lane', travelPos: -5 },
      { laneKey: 'lane', travelPos: 20 },
    ];
    const { leaderIndex, order } = computeFollowOrder(members);
    // Ascending travelPos: index1 (-5) < index2 (20) < index0 (50) -- `order`
    // is front-to-back, i.e. the reverse of that: index0, then index2, then index1.
    expect(order).toEqual([0, 2, 1]);
    expect(leaderIndex[1]).toBe(2);
    expect(leaderIndex[2]).toBe(0);
    expect(leaderIndex[0]).toBe(-1);
  });

  it('keeps separate lanes fully independent of one another', () => {
    const members: LaneMember[] = [
      { laneKey: 'north', travelPos: 0 },
      { laneKey: 'south', travelPos: 0 },
      { laneKey: 'north', travelPos: 5 },
    ];
    const { leaderIndex } = computeFollowOrder(members);
    expect(leaderIndex[1]).toBe(-1); // alone in 'south'
    expect(leaderIndex[2]).toBe(-1); // frontmost in 'north'
    expect(leaderIndex[0]).toBe(2); // follows the other 'north' member
  });

  it('handles an empty member list', () => {
    const { leaderIndex, order } = computeFollowOrder([]);
    expect(leaderIndex.length).toBe(0);
    expect(order).toEqual([]);
  });
});

describe('followTargetSpeed', () => {
  const MIN_SEPARATION = 3;
  const FOLLOW_DISTANCE = 9;

  it('returns full cruise speed once the gap clears followDistance', () => {
    expect(followTargetSpeed(20, 10, 8, MIN_SEPARATION, FOLLOW_DISTANCE)).toBe(10);
    expect(followTargetSpeed(FOLLOW_DISTANCE, 10, 8, MIN_SEPARATION, FOLLOW_DISTANCE)).toBe(10);
  });

  it('returns zero once the gap has closed to minSeparation or less', () => {
    expect(followTargetSpeed(MIN_SEPARATION, 10, 8, MIN_SEPARATION, FOLLOW_DISTANCE)).toBe(0);
    expect(followTargetSpeed(1, 10, 8, MIN_SEPARATION, FOLLOW_DISTANCE)).toBe(0);
    expect(followTargetSpeed(0, 10, 8, MIN_SEPARATION, FOLLOW_DISTANCE)).toBe(0);
  });

  it('ramps linearly between minSeparation and followDistance', () => {
    const midGap = (MIN_SEPARATION + FOLLOW_DISTANCE) / 2;
    const target = followTargetSpeed(midGap, 10, 10, MIN_SEPARATION, FOLLOW_DISTANCE);
    expect(target).toBeCloseTo(5, 5); // halfway through the ramp, at 50% of cruise/leader speed
  });

  it('never targets faster than the leader, even mid-ramp', () => {
    const midGap = (MIN_SEPARATION + FOLLOW_DISTANCE) / 2;
    const target = followTargetSpeed(midGap, 10, 2, MIN_SEPARATION, FOLLOW_DISTANCE);
    expect(target).toBeLessThanOrEqual(2);
  });

  it('never targets faster than cruise speed, even when the leader is faster', () => {
    const target = followTargetSpeed(20, 6, 100, MIN_SEPARATION, FOLLOW_DISTANCE);
    expect(target).toBe(6);
  });
});

describe('approachSpeed', () => {
  it('accelerates toward a higher desired speed, capped by maxDelta', () => {
    expect(approachSpeed(5, 10, 2)).toBe(7);
    expect(approachSpeed(5, 10, 100)).toBe(10); // never overshoots
  });

  it('decelerates toward a lower desired speed, capped by maxDelta', () => {
    expect(approachSpeed(10, 5, 2)).toBe(8);
    expect(approachSpeed(10, 5, 100)).toBe(5); // never undershoots
  });

  it('holds steady once already at the desired speed', () => {
    expect(approachSpeed(7, 7, 3)).toBe(7);
  });
});
