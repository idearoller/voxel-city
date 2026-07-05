/**
 * The WebAudio side of the positional hover-car flyby effect: a fixed pool
 * of `FLYBY_VOICE_COUNT` voices (see `flyby.ts`), each
 *
 *   looping bandpassed noise -> gain -> StereoPannerNode -> `output`
 *
 * built once and reused forever — same "always running, gain is the only
 * knob" shape as the ambient beds in `AudioGraph.ts` (starting/stopping a
 * buffer source on every flyby would both risk the "illegal to start twice"
 * WebAudio error and reintroduce exactly the click/pop this design avoids).
 * `output` is `AmbientGraph.masterGain`, so mute/hidden/unlock gating (and
 * the shared compressor's clip protection) apply to flybys automatically —
 * `AudioSystem` never has to gate this separately.
 *
 * All the interesting decisions — which flyer gets which voice, and what
 * gain/pan/filter values a voice should carry — are pure functions in
 * `flyby.ts`; this class's only job is bookkeeping (the pool's fixed nodes,
 * and each slot's previous target for `assignFlybyVoices`'s continuity
 * check) and pushing the result onto `AudioParam`s via `setTargetAtTime`.
 */

import type {
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  BiquadFilterNodeLike,
  GainNodeLike,
  StereoPannerNodeLike,
} from './types';
import { createNoiseBuffer } from './AudioGraph';
import {
  FLYBY_VOICE_COUNT,
  assignFlybyVoices,
  computeVoiceTarget,
  type FlyerRelativeState,
  type ListenerRight,
} from './flyby';

const VOICE_NOISE_SECONDS = 2;
const VOICE_FILTER_Q = 1.1;

/** Time constants for `setTargetAtTime` -- fast enough that a close, fast pass is audibly tracked, slow enough to stay zipper-free. Silence uses its own (slightly slower) constant so a departing flyer fades rather than cutting off. */
const GAIN_RAMP_TIME_CONSTANT = 0.12;
const PAN_RAMP_TIME_CONSTANT = 0.12;
const FILTER_RAMP_TIME_CONSTANT = 0.2;
const SILENCE_RAMP_TIME_CONSTANT = 0.25;

interface Voice {
  readonly source: AudioBufferSourceNodeLike;
  readonly filter: BiquadFilterNodeLike;
  readonly gain: GainNodeLike;
  readonly panner: StereoPannerNodeLike;
}

function buildVoice(ctx: AudioContextLike, output: AudioNodeLike): Voice {
  const source = ctx.createBufferSource();
  source.buffer = createNoiseBuffer(ctx, VOICE_NOISE_SECONDS);
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = VOICE_FILTER_Q;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  const panner = ctx.createStereoPanner();

  source.connect(filter);
  filter.connect(gain);
  gain.connect(panner);
  panner.connect(output);
  source.start();

  return { source, filter, gain, panner };
}

export class FlybyVoicePool {
  private readonly voices: readonly Voice[];
  /** Each slot's most recently assigned flyer state (a private copy, not the caller's possibly-reused object) -- `null` when the slot is currently silent/unassigned. Feeds `assignFlybyVoices`'s continuity check next tick. */
  private readonly previousTargets: (FlyerRelativeState | null)[];

  constructor(ctx: AudioContextLike, output: AudioNodeLike, voiceCount: number = FLYBY_VOICE_COUNT) {
    const voices: Voice[] = [];
    for (let i = 0; i < voiceCount; i++) voices.push(buildVoice(ctx, output));
    this.voices = voices;
    this.previousTargets = new Array(voiceCount).fill(null);
  }

  /** Reassigns voices and pushes fresh gain/pan/filter targets, called once per tick from `AudioSystem.updateFlybys`. `flyers` may be empty (no flyers in range this frame) -- every voice simply ramps to silence. */
  update(flyers: readonly FlyerRelativeState[], listenerRight: ListenerRight, now: number): void {
    const assignment = assignFlybyVoices(this.previousTargets, flyers);

    for (let slot = 0; slot < this.voices.length; slot++) {
      const voice = this.voices[slot]!;
      const flyerIndex = assignment[slot] ?? null;

      if (flyerIndex === null) {
        voice.gain.gain.setTargetAtTime(0, now, SILENCE_RAMP_TIME_CONSTANT);
        this.previousTargets[slot] = null;
        continue;
      }

      const flyer = flyers[flyerIndex]!;
      const target = computeVoiceTarget(flyer, listenerRight);
      voice.gain.gain.setTargetAtTime(target.gain, now, GAIN_RAMP_TIME_CONSTANT);
      voice.panner.pan.setTargetAtTime(target.pan, now, PAN_RAMP_TIME_CONSTANT);
      voice.filter.frequency.setTargetAtTime(target.filterHz, now, FILTER_RAMP_TIME_CONSTANT);

      // Copy, not a reference -- the caller's `flyers` array/objects may be
      // scratch state it mutates in place next frame (see `EntitySystem`).
      this.previousTargets[slot] = { dx: flyer.dx, dy: flyer.dy, dz: flyer.dz, vx: flyer.vx, vz: flyer.vz };
    }
  }

  dispose(): void {
    for (const voice of this.voices) {
      voice.source.stop();
      voice.source.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
      voice.panner.disconnect();
    }
  }
}
