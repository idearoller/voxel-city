import { describe, expect, it } from 'vitest';
import {
  FLYBY_AUDIBLE_RADIUS,
  FLYBY_VOICE_COUNT,
  assignFlybyVoices,
  computeFlybyGain,
  computeFilterHz,
  computePan,
  computeRadialSpeed,
  computeVoiceTarget,
  distanceOf,
  type FlyerRelativeState,
} from '../../src/audio/flyby';

function flyer(overrides: Partial<FlyerRelativeState> = {}): FlyerRelativeState {
  return { dx: 0, dy: 0, dz: 0, vx: 0, vz: 0, ...overrides };
}

describe('distanceOf', () => {
  it('is the 3D magnitude of the relative position', () => {
    expect(distanceOf(flyer({ dx: 3, dy: 0, dz: 4 }))).toBeCloseTo(5);
  });
});

describe('computeFlybyGain', () => {
  it('is zero at and beyond the audible radius', () => {
    expect(computeFlybyGain(FLYBY_AUDIBLE_RADIUS, 0)).toBe(0);
    expect(computeFlybyGain(FLYBY_AUDIBLE_RADIUS + 10, 0)).toBe(0);
  });

  it('increases monotonically as distance shrinks', () => {
    const far = computeFlybyGain(40, 0);
    const mid = computeFlybyGain(20, 0);
    const near = computeFlybyGain(5, 0);
    expect(mid).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(mid);
  });

  it('never exceeds a conservative ceiling even with a fast approach boost', () => {
    const gain = computeFlybyGain(0, 1000);
    expect(gain).toBeLessThan(0.4);
  });

  it('boosts gain on approach vs. an equally-distant but receding flyer', () => {
    const approaching = computeFlybyGain(15, 20);
    const receding = computeFlybyGain(15, -20);
    const steady = computeFlybyGain(15, 0);
    expect(approaching).toBeGreaterThan(steady);
    expect(receding).toBe(steady);
  });
});

describe('computePan', () => {
  it('is 0 dead ahead / directly overhead (no horizontal offset)', () => {
    expect(computePan(flyer({ dx: 0, dz: 0 }), { x: 1, z: 0 })).toBe(0);
  });

  it('is +1 when the flyer sits fully along the listener right axis', () => {
    expect(computePan(flyer({ dx: 1, dz: 0 }), { x: 1, z: 0 })).toBeCloseTo(1);
  });

  it('is -1 when the flyer sits opposite the listener right axis', () => {
    expect(computePan(flyer({ dx: -1, dz: 0 }), { x: 1, z: 0 })).toBeCloseTo(-1);
  });

  it('does not distinguish ahead from behind (front/back share a pan value)', () => {
    const ahead = computePan(flyer({ dx: 0, dz: 5 }), { x: 1, z: 0 });
    const behind = computePan(flyer({ dx: 0, dz: -5 }), { x: 1, z: 0 });
    expect(ahead).toBeCloseTo(behind);
  });

  it('is clamped to [-1, 1] even for a non-unit right vector', () => {
    expect(computePan(flyer({ dx: 10, dz: 0 }), { x: 5, z: 0 })).toBeLessThanOrEqual(1);
  });
});

describe('computeRadialSpeed', () => {
  it('is positive when the flyer is closing distance', () => {
    // Flyer is 10 units in +x, moving toward the listener (-x).
    const speed = computeRadialSpeed(flyer({ dx: 10, dz: 0, vx: -5, vz: 0 }));
    expect(speed).toBeCloseTo(5);
  });

  it('is negative when the flyer is receding', () => {
    const speed = computeRadialSpeed(flyer({ dx: 10, dz: 0, vx: 5, vz: 0 }));
    expect(speed).toBeCloseTo(-5);
  });

  it('is zero for pure tangential motion (flying past at constant range)', () => {
    const speed = computeRadialSpeed(flyer({ dx: 10, dz: 0, vx: 0, vz: 5 }));
    expect(speed).toBeCloseTo(0);
  });
});

describe('computeFilterHz', () => {
  it('rises above baseline on approach and falls below it on recession', () => {
    const baseline = computeFilterHz(0);
    expect(computeFilterHz(20)).toBeGreaterThan(baseline);
    expect(computeFilterHz(-20)).toBeLessThan(baseline);
  });

  it('saturates rather than diverging for extreme radial speed', () => {
    expect(computeFilterHz(10000)).toBeCloseTo(computeFilterHz(1000));
  });
});

describe('computeVoiceTarget', () => {
  it('combines distance, pan and radial-speed into one target', () => {
    const target = computeVoiceTarget(flyer({ dx: 5, dy: 0, dz: 0, vx: -10, vz: 0 }), { x: 1, z: 0 });
    expect(target.gain).toBeGreaterThan(0);
    expect(target.pan).toBeCloseTo(1);
    expect(target.filterHz).toBeGreaterThan(0);
  });

  it('is silent beyond the audible radius', () => {
    const target = computeVoiceTarget(flyer({ dx: FLYBY_AUDIBLE_RADIUS + 5, dz: 0 }), { x: 1, z: 0 });
    expect(target.gain).toBe(0);
  });
});

describe('assignFlybyVoices', () => {
  const emptySlots = (count: number): null[] => new Array(count).fill(null);

  it('assigns the nearest in-radius flyers to empty slots, nearest first', () => {
    const near = flyer({ dx: 5, dz: 0 });
    const mid = flyer({ dx: 20, dz: 0 });
    const far = flyer({ dx: 40, dz: 0 });
    const assignment = assignFlybyVoices(emptySlots(2), [far, near, mid]);
    expect(assignment[0]).toBe(1); // near
    expect(assignment[1]).toBe(2); // mid
  });

  it('leaves a slot unassigned when there are fewer in-radius flyers than voices', () => {
    const near = flyer({ dx: 5, dz: 0 });
    const assignment = assignFlybyVoices(emptySlots(FLYBY_VOICE_COUNT), [near]);
    expect(assignment[0]).toBe(0);
    for (let i = 1; i < FLYBY_VOICE_COUNT; i++) expect(assignment[i]).toBeNull();
  });

  it('never assigns a flyer beyond the audible radius', () => {
    const outOfRange = flyer({ dx: FLYBY_AUDIBLE_RADIUS + 20, dz: 0 });
    const assignment = assignFlybyVoices(emptySlots(1), [outOfRange]);
    expect(assignment[0]).toBeNull();
  });

  it('keeps a slot\'s occupant across frames when it moves continuously (continuity)', () => {
    const frame1 = flyer({ dx: 30, dz: 0 });
    const firstAssignment = assignFlybyVoices(emptySlots(1), [frame1]);
    expect(firstAssignment[0]).toBe(0);

    const previous = [frame1];
    // Same physical vehicle, one tick later: moved a fraction of a unit.
    const frame2 = flyer({ dx: 29.7, dz: 0 });
    // A brand new, closer flyer also appears in range this frame.
    const newcomer = flyer({ dx: 10, dz: 0 });
    const secondAssignment = assignFlybyVoices(previous, [frame2, newcomer]);
    // With only one voice, continuity keeps the original vehicle's slot
    // rather than snapping to the newcomer purely because it is closer.
    expect(secondAssignment[0]).toBe(0);
  });

  it('frees a slot to the next-closest flyer once its occupant leaves audibility', () => {
    const departing = flyer({ dx: FLYBY_AUDIBLE_RADIUS + 1, dz: 0 }); // just exited
    const previous = [flyer({ dx: FLYBY_AUDIBLE_RADIUS - 1, dz: 0 })];
    const newcomer = flyer({ dx: 15, dz: 0 });
    const assignment = assignFlybyVoices(previous, [departing, newcomer]);
    expect(assignment[0]).toBe(1);
  });

  it('does not chatter between two flyers hovering at nearly equal distance across frames', () => {
    const a = flyer({ dx: 20, dz: 0 });
    const b = flyer({ dx: 20.05, dz: 0 });
    let previous: (FlyerRelativeState | null)[] = [null];
    let assignment = assignFlybyVoices(previous, [a, b]);
    const firstChoice = assignment[0];
    expect(firstChoice).not.toBeNull();

    previous = [firstChoice === 0 ? a : b];
    assignment = assignFlybyVoices(previous, [a, b]);
    expect(assignment[0]).toBe(firstChoice);
  });
});
