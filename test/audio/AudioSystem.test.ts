import { beforeEach, describe, expect, it } from 'vitest';
import { AudioSystem } from '../../src/audio/AudioSystem';
import type { StorageLike } from '../../src/audio/types';
import { FakeAudioContext } from './fakeAudioContext';

class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('AudioSystem', () => {
  let ctx: FakeAudioContext;
  let contextCreateCount: number;
  let system: AudioSystem;

  beforeEach(() => {
    ctx = new FakeAudioContext();
    contextCreateCount = 0;
    system = new AudioSystem(() => {
      contextCreateCount++;
      return ctx;
    }, new FakeStorage());
  });

  describe('unlock', () => {
    it('is locked and has no effect on the mix before the first unlock() call', () => {
      expect(system.isUnlocked).toBe(false);
      system.update({ timeOfDay: 0, rainIntensity: 1, isPlayMode: true });
      expect(ctx.resumeCount).toBe(0);
    });

    it('creates the context and resumes it on first unlock()', () => {
      system.unlock();
      expect(system.isUnlocked).toBe(true);
      expect(contextCreateCount).toBe(1);
      expect(ctx.resumeCount).toBe(1);
    });

    it('never creates a second context or resumes twice on repeated unlock() calls (the click/keydown handler fires many times per session)', () => {
      system.unlock();
      system.unlock();
      system.unlock();
      expect(contextCreateCount).toBe(1);
      expect(ctx.resumeCount).toBe(1);
    });

    it('degrades silently when the context factory returns null (WebAudio unavailable)', () => {
      const silentSystem = new AudioSystem(() => null, new FakeStorage());
      expect(() => silentSystem.unlock()).not.toThrow();
      expect(silentSystem.isUnlocked).toBe(false);
      expect(() => silentSystem.update({ timeOfDay: 0, rainIntensity: 0, isPlayMode: true })).not.toThrow();
      expect(() => silentSystem.setMuted(true)).not.toThrow();
      expect(() => silentSystem.setHidden(true)).not.toThrow();
    });
  });

  describe('update', () => {
    it('ramps the three bus gains toward computeAmbientMix output after unlock', () => {
      system.unlock();
      system.update({ timeOfDay: 0, rainIntensity: 1, isPlayMode: true });

      const [rainGain] = ctx.gainNodes.filter((g) => g.gain.setTargetAtTimeCalls.length > 0);
      expect(rainGain).toBeDefined();
      // Every bus gain should have received a ramp target.
      const targeted = ctx.gainNodes.filter((g) => g.gain.setTargetAtTimeCalls.length > 0);
      expect(targeted.length).toBeGreaterThanOrEqual(3);
    });

    it('does not re-issue setTargetAtTime on subsequent ticks when the mix is unchanged (skips redundant automation events)', () => {
      system.unlock();
      const state = { timeOfDay: 0.2, rainIntensity: 0.6, isPlayMode: true };
      system.update(state);

      const callCountsAfterFirst = ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length);

      // Same state, several more ticks -- every bus gain already ramping
      // toward the same target should receive no further calls.
      system.update(state);
      system.update(state);
      system.update(state);

      const callCountsAfterRepeats = ctx.gainNodes.map((g) => g.gain.setTargetAtTimeCalls.length);
      expect(callCountsAfterRepeats).toEqual(callCountsAfterFirst);
    });

    it('does re-issue setTargetAtTime once the mix actually changes after a run of unchanged ticks', () => {
      system.unlock();
      const stateA = { timeOfDay: 0.2, rainIntensity: 0.6, isPlayMode: true };
      system.update(stateA);
      system.update(stateA);
      const callCountsAfterA = ctx.gainNodes.reduce((sum, g) => sum + g.gain.setTargetAtTimeCalls.length, 0);

      const stateB = { timeOfDay: 0.2, rainIntensity: 0, isPlayMode: true }; // rain fully stops -- rainGain target changes
      system.update(stateB);
      const callCountsAfterB = ctx.gainNodes.reduce((sum, g) => sum + g.gain.setTargetAtTimeCalls.length, 0);

      expect(callCountsAfterB).toBeGreaterThan(callCountsAfterA);
    });
  });

  describe('updateFlybys', () => {
    it('is a no-op before unlock()', () => {
      expect(() => system.updateFlybys([{ dx: 5, dy: 0, dz: 0, vx: -1, vz: 0 }], { x: 1, z: 0 })).not.toThrow();
      expect(ctx.gainNodes).toHaveLength(0);
    });

    it('drives a voice gain after unlock() when a flyer is within range', () => {
      system.unlock();
      system.updateFlybys([{ dx: 5, dy: 0, dz: 0, vx: -10, vz: 0 }], { x: 1, z: 0 });

      const drivenGains = ctx.gainNodes.filter((g) => g.gain.setTargetAtTimeCalls.some((v) => v > 0));
      expect(drivenGains.length).toBeGreaterThanOrEqual(1);
    });

    it('is safe to call when WebAudio is unavailable', () => {
      const silentSystem = new AudioSystem(() => null, new FakeStorage());
      expect(() => silentSystem.updateFlybys([], { x: 1, z: 0 })).not.toThrow();
    });
  });

  describe('mute', () => {
    it('starts unmuted by default', () => {
      expect(system.isMuted).toBe(false);
    });

    it('setMuted(true) cuts the master gain to 0 immediately', () => {
      system.unlock();
      system.setMuted(true);
      expect(system.isMuted).toBe(true);
      // masterGain is the first gain node buildAmbientGraph creates, before any bus gain.
      const masterGain = ctx.gainNodes[0]!;
      expect(masterGain.gain.setValueAtTimeCalls).toContain(0);
    });

    it('setMuted(false) after muting ramps the master gain back up', () => {
      system.unlock();
      system.setMuted(true);
      system.setMuted(false);
      expect(system.isMuted).toBe(false);
      const masterGain = ctx.gainNodes[0]!;
      expect(masterGain.gain.setTargetAtTimeCalls.length).toBeGreaterThan(0);
    });

    it('toggleMuted flips the current state', () => {
      system.unlock();
      system.toggleMuted();
      expect(system.isMuted).toBe(true);
      system.toggleMuted();
      expect(system.isMuted).toBe(false);
    });

    it('muting suspends the context (stop burning CPU while silent)', () => {
      system.unlock();
      expect(ctx.state).toBe('running');
      system.setMuted(true);
      expect(ctx.state).toBe('suspended');
      expect(ctx.suspendCount).toBe(1);
    });

    it('unmuting resumes the context when the tab is still visible', () => {
      system.unlock();
      system.setMuted(true);
      system.setMuted(false);
      expect(ctx.state).toBe('running');
    });
  });

  describe('visibility', () => {
    it('setHidden(true) suspends a running context', () => {
      system.unlock();
      system.setHidden(true);
      expect(ctx.state).toBe('suspended');
      expect(ctx.suspendCount).toBe(1);
    });

    it('setHidden(false) resumes when unmuted', () => {
      system.unlock();
      system.setHidden(true);
      system.setHidden(false);
      expect(ctx.state).toBe('running');
    });

    it('becoming visible again while still muted does not resume the context', () => {
      system.unlock();
      system.setMuted(true);
      system.setHidden(true);
      system.setHidden(false);
      expect(ctx.state).toBe('suspended');
    });

    it('unmuting while the tab is hidden does not resume the context', () => {
      system.unlock();
      system.setHidden(true);
      system.setMuted(true);
      system.setMuted(false);
      expect(ctx.state).toBe('suspended');
    });
  });

  describe('dispose', () => {
    it('closes the context and disposes the graph', () => {
      system.unlock();
      system.dispose();
      expect(ctx.closeCount).toBe(1);
    });

    it('also disposes the flyby voice pool (stops every voice noise source)', () => {
      system.unlock();
      system.dispose();
      for (const source of ctx.bufferSources) {
        expect(source.stopCount).toBe(1);
      }
    });

    it('is safe to call before unlock()', () => {
      expect(() => system.dispose()).not.toThrow();
    });
  });
});
