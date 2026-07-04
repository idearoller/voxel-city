/**
 * Orchestrates the ambient audio lifecycle: browser autoplay policy requires
 * an `AudioContext` to be created (or resumed) from inside a user-gesture
 * event handler, so `unlock()` is meant to be wired to the same click that
 * already requests pointer lock (see `LookControls`) or a keydown, and is
 * idempotent — the game already fires many clicks/keydowns per session and
 * this must only build the graph once.
 *
 * Three independent concerns are deliberately kept separate and composed
 * here rather than folded into one class:
 *  - `computeAmbientMix` (mix.ts): pure timeOfDay/rain/mode -> gain curve.
 *  - `MutePreference`: pure localStorage-backed boolean.
 *  - `buildAmbientGraph` (AudioGraph.ts): the actual WebAudio node graph.
 * `AudioSystem` just wires those three together against a real (or, in
 * tests, fake) `AudioContextLike` and reacts to tab-visibility changes.
 *
 * Degrades silently everywhere: if `createContext()` returns null (WebAudio
 * unavailable, or its constructor throws in some old/locked-down browser),
 * every method becomes a no-op instead of throwing — the game is fully
 * playable with no ambient audio at all.
 */

import { computeAmbientMix, type AmbientState } from './mix';
import { MutePreference } from './MutePreference';
import type { AudioContextLike, StorageLike } from './types';
import { buildAmbientGraph, type AmbientGraph } from './AudioGraph';

/** Seconds for `setTargetAtTime`'s exponential approach — smooths mix changes (rain toggling, day/night drift) without audible zipper noise, while still settling within a couple of seconds. */
const MIX_RAMP_TIME_CONSTANT = 1.2;
/** Fade-in time constant when unmuting/unlocking — slightly slower than mix ramps so the ambient bed eases in rather than snapping to full presence. */
const MASTER_RAMP_TIME_CONSTANT = 1.5;
const MASTER_GAIN = 0.6;

export type AudioContextFactory = () => AudioContextLike | null;

export class AudioSystem {
  private ctx: AudioContextLike | null = null;
  private graph: AmbientGraph | null = null;
  private unlockedFlag = false;
  private hidden = false;
  private readonly mutePreference: MutePreference;

  constructor(
    private readonly createContext: AudioContextFactory,
    storage: StorageLike | null,
  ) {
    this.mutePreference = new MutePreference(storage);
  }

  get isUnlocked(): boolean {
    return this.unlockedFlag;
  }

  get isMuted(): boolean {
    return this.mutePreference.muted;
  }

  /**
   * Builds the audio graph and resumes the context. Safe to call from every
   * click/keydown handler unconditionally — only the first call (per
   * instance) does anything; every call after that is a no-op guard check.
   */
  unlock(): void {
    if (this.unlockedFlag) return;
    const ctx = this.createContext();
    if (!ctx) return; // WebAudio unavailable -- stay silent, no error
    this.unlockedFlag = true;
    this.ctx = ctx;
    this.graph = buildAmbientGraph(ctx);
    // Resume is owned by applySuspendState (a fresh context reports
    // 'suspended', so the unmuted-visible path resumes it here). An
    // unconditional resume() would race its own async resolution against
    // the mute check and leave a muted player's context running silently.
    this.applyMuteToMasterGain();
    this.applySuspendState();
  }

  setMuted(muted: boolean): void {
    this.mutePreference.set(muted);
    this.applyMuteToMasterGain();
    this.applySuspendState();
  }

  toggleMuted(): void {
    this.setMuted(!this.mutePreference.muted);
  }

  /** Call on the page's `visibilitychange` event with `document.hidden`. Suspends the context while hidden (or muted) so no CPU is spent generating audio nobody can hear, and resumes when both conditions clear. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.applySuspendState();
  }

  /** Pushes `computeAmbientMix(state)` onto the three bus gains via ramps. No-op before `unlock()` (nothing to drive yet) — main.ts is expected to call this every tick regardless of unlock state. */
  update(state: AmbientState): void {
    if (!this.ctx || !this.graph) return;
    const mix = computeAmbientMix(state);
    const now = this.ctx.currentTime;
    this.graph.rainGain.gain.setTargetAtTime(mix.rainGain, now, MIX_RAMP_TIME_CONSTANT);
    this.graph.humGain.gain.setTargetAtTime(mix.humGain, now, MIX_RAMP_TIME_CONSTANT);
    this.graph.trafficGain.gain.setTargetAtTime(mix.trafficGain, now, MIX_RAMP_TIME_CONSTANT);
  }

  /**
   * Muting cuts to silence immediately (there's nothing to hear either way
   * once `applySuspendState` suspends the context right after), while
   * unmuting ramps back up so the ambient bed doesn't pop in at full level.
   */
  private applyMuteToMasterGain(): void {
    if (!this.ctx || !this.graph) return;
    if (this.mutePreference.muted) {
      this.graph.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
    } else {
      this.graph.masterGain.gain.setTargetAtTime(MASTER_GAIN, this.ctx.currentTime, MASTER_RAMP_TIME_CONSTANT);
    }
  }

  private applySuspendState(): void {
    if (!this.ctx) return;
    const shouldSuspend = this.hidden || this.mutePreference.muted;
    if (shouldSuspend && this.ctx.state === 'running') {
      void this.ctx.suspend();
    } else if (!shouldSuspend && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  dispose(): void {
    this.graph?.dispose();
    void this.ctx?.close();
  }
}
