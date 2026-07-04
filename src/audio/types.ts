/**
 * Narrow structural subset of the WebAudio API that `AudioGraph`/`AudioSystem`
 * depend on. Two things this buys us:
 *
 *  1. `audio/` never imports `lib.dom`'s `AudioContext` type directly, so
 *     nothing here accidentally reaches for `window`/`document` — the module
 *     only ever touches whatever `AudioContextLike` it's handed.
 *  2. Tests can hand-roll a fake implementing exactly these members (see
 *     `test/audio/fakeAudioContext.ts`) instead of pulling in a mock library
 *     or a jsdom-flavoured shim for an API jsdom doesn't implement anyway.
 *
 * A real browser `AudioContext`/`AudioNode`/etc. structurally satisfies every
 * interface below (they're all subsets of the real thing), so production
 * code passes a real `AudioContext` in with no cast.
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  /** Exponential approach toward `target`, reached asymptotically over ~`timeConstant` seconds — the standard WebAudio idiom for zipper-free continuous parameter follows. */
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void;
}

export interface AudioNodeLike {
  /**
   * Real `AudioNode.connect` is overloaded: connecting to another node
   * returns that node (for chaining); connecting to an `AudioParam` (e.g.
   * wiring an LFO oscillator into a filter's `frequency`) returns nothing.
   * The union parameter covers both use sites in `AudioGraph.ts`; the
   * `void` return keeps callers from relying on chaining, which this
   * codebase's graph-building never does.
   */
  connect(destination: AudioNodeLike | AudioParamLike): void;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorType;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly ratio: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  /** `'interrupted'` is a newer state (e.g. Safari backgrounding); not distinguished from `'suspended'` anywhere in this codebase, but included so a real `AudioContext` is structurally assignable without a cast. */
  readonly state: 'suspended' | 'running' | 'closed' | 'interrupted';
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/** Whatever main.ts hands in for mute persistence — real `window.localStorage`, structurally. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
