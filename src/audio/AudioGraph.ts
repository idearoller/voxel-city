/**
 * Builds the ambient audio graph once, entirely from procedural sources —
 * no audio files, matching the project's no-assets/browser-only posture.
 * Three independent beds sum into a shared master bus:
 *
 *  Rain    noise buffer (looped) -> highpass(600Hz) -> lowpass(5000Hz)
 *          -> rainGain
 *  Hum     50Hz osc + 100Hz osc (2nd harmonic) -> bandpass(90Hz, tight Q)
 *          -> flickerGain (amplitude-modulated by a ~0.2Hz LFO for a subtle
 *             "unstable ballast" character) -> humGain
 *  Traffic noise buffer (looped, independent buffer from rain's) ->
 *          lowpass(300Hz) swept gently by a slow LFO on its cutoff (for a
 *          "distant passing vehicle" whoosh) -> trafficGain
 *
 * rainGain/humGain/trafficGain are the three knobs `AudioSystem.update()`
 * turns every tick (via `computeAmbientMix`); everything upstream of them
 * runs forever unattended once started. All three buses sum into
 * `masterGain -> compressor -> destination`: the compressor is a safety net
 * (threshold -24dB, ratio 3:1) so even a worst-case moment (max rain + peak
 * hum + peak traffic, ~0.32 summed headroom already) can never clip.
 *
 * `dispose()` stops every oscillator/buffer source (illegal to start twice,
 * harmless to stop once) and disconnects every node — mirrors
 * `Atmosphere.dispose`/`Rain.dispose`'s teardown shape even though nothing
 * calls it yet in a single-page app that never tears down its audio.
 */

import type {
  AudioContextLike,
  AudioNodeLike,
  GainNodeLike,
} from './types';

/** Anything with a `.stop()` -- oscillators and buffer sources -- collected per bed so `dispose()` can actually stop them instead of just disconnecting (a disconnected-but-still-running source is still doing work until GC'd). */
interface Stoppable {
  stop(when?: number): void;
}

const RAIN_NOISE_SECONDS = 2;
const RAIN_HIGHPASS_HZ = 600;
const RAIN_LOWPASS_HZ = 5000;

const HUM_FUNDAMENTAL_HZ = 50; // mains electrical hum fundamental
const HUM_HARMONIC_HZ = 100; // 2nd harmonic -- the "buzz" component of a bad ballast
const HUM_BANDPASS_HZ = 90;
const HUM_BANDPASS_Q = 4;
const HUM_FLICKER_LFO_HZ = 0.2;
const HUM_FLICKER_DEPTH = 0.25; // fraction of full amplitude the flicker LFO swings

const TRAFFIC_NOISE_SECONDS = 3;
const TRAFFIC_LOWPASS_HZ = 300;
const TRAFFIC_LOWPASS_SWEEP_LFO_HZ = 0.07;
const TRAFFIC_LOWPASS_SWEEP_DEPTH_HZ = 120;

const COMPRESSOR_THRESHOLD_DB = -24;
const COMPRESSOR_RATIO = 3;

export interface AmbientGraph {
  readonly rainGain: GainNodeLike;
  readonly humGain: GainNodeLike;
  readonly trafficGain: GainNodeLike;
  readonly masterGain: GainNodeLike;
  dispose(): void;
}

/** Fills a mono buffer with uniform white noise in [-1, 1) -- the shared raw material for both the rain and traffic beds (each gets its own buffer/source so they can be filtered independently). */
function createNoiseBuffer(ctx: AudioContextLike, seconds: number) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** A looping noise source built fresh from `createNoiseBuffer` -- one per bed, since sharing a single `AudioBufferSourceNode` between two graphs isn't possible (a source node can only be started/connected once). */
function createLoopingNoiseSource(ctx: AudioContextLike, seconds: number) {
  const source = ctx.createBufferSource();
  source.buffer = createNoiseBuffer(ctx, seconds);
  source.loop = true;
  return source;
}

/** An oscillator + a scaling gain node that feeds an `AudioParam` as an LFO, wired and started but not yet connected to its modulation target. */
function createLfo(ctx: AudioContextLike, frequencyHz: number, depth: number) {
  const oscillator = ctx.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequencyHz;
  const depthGain = ctx.createGain();
  depthGain.gain.value = depth;
  oscillator.connect(depthGain);
  return { oscillator, depthGain };
}

interface Bed {
  readonly gain: GainNodeLike;
  readonly stoppables: readonly Stoppable[];
}

function buildRainBed(ctx: AudioContextLike, output: AudioNodeLike): Bed {
  const source = createLoopingNoiseSource(ctx, RAIN_NOISE_SECONDS);

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = RAIN_HIGHPASS_HZ;
  highpass.Q.value = 0.7;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = RAIN_LOWPASS_HZ;
  lowpass.Q.value = 0.7;

  const rainGain = ctx.createGain();
  rainGain.gain.value = 0;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(rainGain);
  rainGain.connect(output);

  source.start();
  return { gain: rainGain, stoppables: [source] };
}

function buildHumBed(ctx: AudioContextLike, output: AudioNodeLike): Bed {
  const fundamental = ctx.createOscillator();
  fundamental.type = 'sine';
  fundamental.frequency.value = HUM_FUNDAMENTAL_HZ;

  const harmonic = ctx.createOscillator();
  harmonic.type = 'sine';
  harmonic.frequency.value = HUM_HARMONIC_HZ;

  const toneMix = ctx.createGain();
  toneMix.gain.value = 0.5; // 50/50 blend of fundamental + 2nd harmonic before the bandpass

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = HUM_BANDPASS_HZ;
  bandpass.Q.value = HUM_BANDPASS_Q;

  // Flicker: an LFO-modulated gain sitting *inside* the hum bed, upstream of
  // the bus-level `humGain` that `AudioSystem` drives. Its base value (1)
  // plus the LFO's +/-depth swing means the flicker only ever attenuates
  // toward silence in brief troughs, never inverts phase or clips above 1.
  const flickerGain = ctx.createGain();
  flickerGain.gain.value = 1;
  const flickerLfo = createLfo(ctx, HUM_FLICKER_LFO_HZ, HUM_FLICKER_DEPTH);
  flickerLfo.depthGain.connect(flickerGain.gain);

  const humGain = ctx.createGain();
  humGain.gain.value = 0;

  fundamental.connect(toneMix);
  harmonic.connect(toneMix);
  toneMix.connect(bandpass);
  bandpass.connect(flickerGain);
  flickerGain.connect(humGain);
  humGain.connect(output);

  fundamental.start();
  harmonic.start();
  flickerLfo.oscillator.start();
  return { gain: humGain, stoppables: [fundamental, harmonic, flickerLfo.oscillator] };
}

function buildTrafficBed(ctx: AudioContextLike, output: AudioNodeLike): Bed {
  const source = createLoopingNoiseSource(ctx, TRAFFIC_NOISE_SECONDS);

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = TRAFFIC_LOWPASS_HZ;
  lowpass.Q.value = 0.6;

  // Sweeping the cutoff slowly (rather than the gain) reads as "vehicles
  // passing at a distance" instead of a mechanical volume pulse.
  const sweepLfo = createLfo(ctx, TRAFFIC_LOWPASS_SWEEP_LFO_HZ, TRAFFIC_LOWPASS_SWEEP_DEPTH_HZ);
  sweepLfo.depthGain.connect(lowpass.frequency);

  const trafficGain = ctx.createGain();
  trafficGain.gain.value = 0;

  source.connect(lowpass);
  lowpass.connect(trafficGain);
  trafficGain.connect(output);

  source.start();
  sweepLfo.oscillator.start();
  return { gain: trafficGain, stoppables: [source, sweepLfo.oscillator] };
}

export function buildAmbientGraph(ctx: AudioContextLike): AmbientGraph {
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0; // AudioSystem ramps this up once unlocked+unmuted

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR_THRESHOLD_DB;
  compressor.ratio.value = COMPRESSOR_RATIO;

  masterGain.connect(compressor);
  compressor.connect(ctx.destination);

  const rain = buildRainBed(ctx, masterGain);
  const hum = buildHumBed(ctx, masterGain);
  const traffic = buildTrafficBed(ctx, masterGain);
  const allStoppables = [...rain.stoppables, ...hum.stoppables, ...traffic.stoppables];

  return {
    rainGain: rain.gain,
    humGain: hum.gain,
    trafficGain: traffic.gain,
    masterGain,
    dispose(): void {
      for (const stoppable of allStoppables) stoppable.stop();
      rain.gain.disconnect();
      hum.gain.disconnect();
      traffic.gain.disconnect();
      masterGain.disconnect();
      compressor.disconnect();
    },
  };
}
