/**
 * Hand-rolled fake implementing exactly `AudioContextLike` (see
 * `src/audio/types.ts`) -- no mock library, no jsdom WebAudio shim (jsdom
 * doesn't implement WebAudio at all, and vitest here runs with
 * `environment: 'node'` anyway, see `vitest.config.ts`). Every node counts
 * `connect`/`start`/`stop` calls so tests can assert graph shape and
 * lifecycle behavior (started-exactly-once, disposed-stops-everything)
 * without caring about actual DSP output.
 */
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
  StereoPannerNodeLike,
} from '../../src/audio/types';

export class FakeAudioParam implements AudioParamLike {
  value = 0;
  setValueAtTimeCalls: number[] = [];
  setTargetAtTimeCalls: number[] = [];

  setValueAtTime(value: number): void {
    this.value = value;
    this.setValueAtTimeCalls.push(value);
  }

  setTargetAtTime(target: number): void {
    this.value = target;
    this.setTargetAtTimeCalls.push(target);
  }
}

class FakeNode implements AudioNodeLike {
  readonly connectedTo: (AudioNodeLike | AudioParamLike)[] = [];
  disconnectCount = 0;

  connect(destination: AudioNodeLike | AudioParamLike): void {
    this.connectedTo.push(destination);
  }

  disconnect(): void {
    this.disconnectCount++;
    this.connectedTo.length = 0;
  }
}

export class FakeGainNode extends FakeNode implements GainNodeLike {
  readonly gain = new FakeAudioParam();
}

export class FakeBiquadFilterNode extends FakeNode implements BiquadFilterNodeLike {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

export class FakeOscillatorNode extends FakeNode implements OscillatorNodeLike {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  startCount = 0;
  stopCount = 0;

  start(): void {
    this.startCount++;
  }

  stop(): void {
    this.stopCount++;
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  private readonly data: Float32Array;

  constructor(length: number) {
    this.data = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeBufferSourceNode extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  startCount = 0;
  stopCount = 0;

  start(): void {
    this.startCount++;
  }

  stop(): void {
    this.stopCount++;
  }
}

export class FakeDynamicsCompressorNode extends FakeNode implements DynamicsCompressorNodeLike {
  readonly threshold = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
}

export class FakeStereoPannerNode extends FakeNode implements StereoPannerNodeLike {
  readonly pan = new FakeAudioParam();
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  sampleRate = 44100;
  readonly destination = new FakeNode();
  state: 'suspended' | 'running' | 'closed' = 'suspended';

  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;

  readonly gainNodes: FakeGainNode[] = [];
  readonly filterNodes: FakeBiquadFilterNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly compressors: FakeDynamicsCompressorNode[] = [];
  readonly stereoPanners: FakeStereoPannerNode[] = [];

  createGain(): GainNodeLike {
    const node = new FakeGainNode();
    this.gainNodes.push(node);
    return node;
  }

  createBiquadFilter(): BiquadFilterNodeLike {
    const node = new FakeBiquadFilterNode();
    this.filterNodes.push(node);
    return node;
  }

  createOscillator(): OscillatorNodeLike {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createBuffer(_numberOfChannels: number, length: number): AudioBufferLike {
    return new FakeAudioBuffer(length);
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createDynamicsCompressor(): DynamicsCompressorNodeLike {
    const node = new FakeDynamicsCompressorNode();
    this.compressors.push(node);
    return node;
  }

  createStereoPanner(): StereoPannerNodeLike {
    const node = new FakeStereoPannerNode();
    this.stereoPanners.push(node);
    return node;
  }

  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCount++;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.state = 'closed';
  }
}
