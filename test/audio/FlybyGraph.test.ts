import { describe, expect, it } from 'vitest';
import { FlybyVoicePool } from '../../src/audio/FlybyGraph';
import { FLYBY_AUDIBLE_RADIUS, FLYBY_VOICE_COUNT, type FlyerRelativeState } from '../../src/audio/flyby';
import { FakeAudioContext } from './fakeAudioContext';

function flyer(overrides: Partial<FlyerRelativeState> = {}): FlyerRelativeState {
  return { dx: 0, dy: 0, dz: 0, vx: 0, vz: 0, ...overrides };
}

describe('FlybyVoicePool', () => {
  it('builds exactly FLYBY_VOICE_COUNT voices, each with a looping noise source, a bandpass filter, a gain and a stereo panner, all starting silent', () => {
    const ctx = new FakeAudioContext();
    new FlybyVoicePool(ctx, ctx.destination);

    expect(ctx.bufferSources).toHaveLength(FLYBY_VOICE_COUNT);
    expect(ctx.stereoPanners).toHaveLength(FLYBY_VOICE_COUNT);
    const bandpassFilters = ctx.filterNodes.filter((f) => f.type === 'bandpass');
    expect(bandpassFilters).toHaveLength(FLYBY_VOICE_COUNT);

    for (const source of ctx.bufferSources) {
      expect(source.loop).toBe(true);
      expect(source.startCount).toBe(1);
    }
    // One gain node per voice -- all silent until update() assigns a flyer.
    expect(ctx.gainNodes).toHaveLength(FLYBY_VOICE_COUNT);
    for (const gain of ctx.gainNodes) {
      expect(gain.gain.value).toBe(0);
    }
  });

  it('connects every voice into the given output node', () => {
    const ctx = new FakeAudioContext();
    new FlybyVoicePool(ctx, ctx.destination);

    // panner -> output is the last hop in each voice's chain.
    for (const panner of ctx.stereoPanners) {
      expect(panner.connectedTo).toContain(ctx.destination);
    }
  });

  it('never creates new nodes on update() -- the pool is fixed-size and reused every tick', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: 10 })], { x: 1, z: 0 }, 0);
    pool.update([flyer({ dx: 20 }), flyer({ dx: 5 })], { x: 1, z: 0 }, 1);

    expect(ctx.bufferSources).toHaveLength(FLYBY_VOICE_COUNT);
    expect(ctx.gainNodes).toHaveLength(FLYBY_VOICE_COUNT);
    expect(ctx.stereoPanners).toHaveLength(FLYBY_VOICE_COUNT);
  });

  it('drives an assigned voice\'s gain, pan and filter frequency toward the computed target', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: 5, dz: 0, vx: -10 })], { x: 1, z: 0 }, 0);

    const drivenGain = ctx.gainNodes.find((g) => g.gain.setTargetAtTimeCalls.length > 0);
    expect(drivenGain).toBeDefined();
    expect(drivenGain!.gain.setTargetAtTimeCalls[0]).toBeGreaterThan(0);

    const drivenPan = ctx.stereoPanners.find((p) => p.pan.setTargetAtTimeCalls.length > 0);
    expect(drivenPan).toBeDefined();
    expect(drivenPan!.pan.setTargetAtTimeCalls[0]).toBeCloseTo(1);

    const drivenFilter = ctx.filterNodes.find((f) => f.type === 'bandpass' && f.frequency.setTargetAtTimeCalls.length > 0);
    expect(drivenFilter).toBeDefined();
  });

  it('ramps an unassigned voice toward silence rather than leaving it at a stale gain', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: 5 })], { x: 1, z: 0 }, 0);
    pool.update([], { x: 1, z: 0 }, 1); // flyer left audibility entirely

    const silencedGains = ctx.gainNodes.filter((g) => g.gain.setTargetAtTimeCalls.at(-1) === 0);
    expect(silencedGains.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves flyers beyond the audible radius silent', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: FLYBY_AUDIBLE_RADIUS + 10 })], { x: 1, z: 0 }, 0);

    for (const gain of ctx.gainNodes) {
      expect(gain.gain.setTargetAtTimeCalls.every((v) => v === 0)).toBe(true);
    }
  });

  it('does not re-issue setTargetAtTime for a voice whose flyer state (and thus target) is unchanged tick to tick', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);
    const state = flyer({ dx: 5, dz: 0, vx: -10 });

    pool.update([state], { x: 1, z: 0 }, 0);
    const callCountsAfterFirst = ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length);
    const panCountsAfterFirst = ctx.stereoPanners.map((p) => p.pan.setTargetAtTimeCalls.length);

    // Same flyer state (a fresh object with identical fields, not the same
    // reference) on the next two ticks -- the computed target is identical,
    // so no further ramp calls should be issued.
    pool.update([flyer({ dx: 5, dz: 0, vx: -10 })], { x: 1, z: 0 }, 1);
    pool.update([flyer({ dx: 5, dz: 0, vx: -10 })], { x: 1, z: 0 }, 2);

    expect(ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length)).toEqual(callCountsAfterFirst);
    expect(ctx.stereoPanners.map((p) => p.pan.setTargetAtTimeCalls.length)).toEqual(panCountsAfterFirst);
  });

  it('does re-issue setTargetAtTime once the flyer actually moves after a run of unchanged ticks', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: 5, dz: 0, vx: -10 })], { x: 1, z: 0 }, 0);
    pool.update([flyer({ dx: 5, dz: 0, vx: -10 })], { x: 1, z: 0 }, 1);
    const callsBeforeMove = ctx.gainNodes.reduce((sum, g) => sum + g.gain.setTargetAtTimeCalls.length, 0);

    pool.update([flyer({ dx: 20, dz: 0, vx: -10 })], { x: 1, z: 0 }, 2); // much farther -- gain target changes
    const callsAfterMove = ctx.gainNodes.reduce((sum, g) => sum + g.gain.setTargetAtTimeCalls.length, 0);

    expect(callsAfterMove).toBeGreaterThan(callsBeforeMove);
  });

  it('a stale-then-repeated silence does not keep re-issuing the same silent target', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.update([flyer({ dx: 5 })], { x: 1, z: 0 }, 0);
    pool.update([], { x: 1, z: 0 }, 1); // flyer leaves -- voice ramps to silence
    const callCountsAfterSilence = ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length);

    pool.update([], { x: 1, z: 0 }, 2);
    pool.update([], { x: 1, z: 0 }, 3);

    expect(ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length)).toEqual(callCountsAfterSilence);
  });

  it('dispose() stops every noise source and disconnects every node exactly once', () => {
    const ctx = new FakeAudioContext();
    const pool = new FlybyVoicePool(ctx, ctx.destination);

    pool.dispose();

    for (const source of ctx.bufferSources) expect(source.stopCount).toBe(1);
    for (const gain of ctx.gainNodes) expect(gain.disconnectCount).toBe(1);
    for (const panner of ctx.stereoPanners) expect(panner.disconnectCount).toBe(1);
    const bandpassFilters = ctx.filterNodes.filter((f) => f.type === 'bandpass');
    for (const filter of bandpassFilters) expect(filter.disconnectCount).toBe(1);
  });
});
