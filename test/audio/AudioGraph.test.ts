import { describe, expect, it } from 'vitest';
import { buildAmbientGraph } from '../../src/audio/AudioGraph';
import { FakeAudioContext, FakeGainNode } from './fakeAudioContext';

/** Test-only narrowing: `AmbientGraph` exposes its bus gains as the structural `GainNodeLike`, but every node built here is actually a `FakeGainNode` -- this cast lets assertions reach the fake's call-recording fields. */
function asFake(gain: { gain: { value: number } }): FakeGainNode {
  return gain as FakeGainNode;
}

describe('buildAmbientGraph', () => {
  it('creates three distinct bus gains plus a master gain, all starting silent', () => {
    const ctx = new FakeAudioContext();
    const graph = buildAmbientGraph(ctx);

    const buses = [graph.rainGain, graph.humGain, graph.trafficGain, graph.masterGain];
    expect(new Set(buses).size).toBe(4); // all distinct nodes
    for (const bus of buses) {
      expect(bus.gain.value).toBe(0);
    }
  });

  it('routes the master bus through exactly one compressor into the context destination', () => {
    const ctx = new FakeAudioContext();
    const graph = buildAmbientGraph(ctx);

    expect(ctx.compressors).toHaveLength(1);
    const compressor = ctx.compressors[0]!;
    expect(asFake(graph.masterGain).connectedTo).toContain(compressor);
    expect(compressor.connectedTo).toContain(ctx.destination);
  });

  it('starts every oscillator and buffer source exactly once (starting twice throws in real WebAudio)', () => {
    const ctx = new FakeAudioContext();
    buildAmbientGraph(ctx);

    // 2 hum tone oscillators (fundamental + 2nd harmonic) + 2 LFOs (hum flicker, traffic sweep).
    expect(ctx.oscillators).toHaveLength(4);
    for (const oscillator of ctx.oscillators) {
      expect(oscillator.startCount).toBe(1);
    }

    // 1 rain noise source + 1 traffic noise source.
    expect(ctx.bufferSources).toHaveLength(2);
    for (const source of ctx.bufferSources) {
      expect(source.startCount).toBe(1);
      expect(source.loop).toBe(true);
    }
  });

  it('fills each noise buffer source with a full (non-silent) buffer', () => {
    const ctx = new FakeAudioContext();
    buildAmbientGraph(ctx);

    for (const source of ctx.bufferSources) {
      const data = source.buffer?.getChannelData(0);
      expect(data).toBeDefined();
      expect(data!.length).toBeGreaterThan(0);
      // White noise should not be all zeros.
      expect(data!.some((sample) => sample !== 0)).toBe(true);
    }
  });

  it('the hum bed centers its tone oscillators on 50Hz and its 2nd harmonic at 100Hz', () => {
    const ctx = new FakeAudioContext();
    buildAmbientGraph(ctx);

    const frequencies = ctx.oscillators
      .map((osc) => osc.frequency.value)
      .filter((hz) => hz === 50 || hz === 100);
    expect(frequencies.sort((a, b) => a - b)).toEqual([50, 100]);
  });

  it('dispose() stops every oscillator and buffer source and disconnects the bus gains', () => {
    const ctx = new FakeAudioContext();
    const graph = buildAmbientGraph(ctx);

    graph.dispose();

    for (const oscillator of ctx.oscillators) {
      expect(oscillator.stopCount).toBe(1);
    }
    for (const source of ctx.bufferSources) {
      expect(source.stopCount).toBe(1);
    }
    expect(asFake(graph.rainGain).disconnectCount).toBe(1);
    expect(asFake(graph.humGain).disconnectCount).toBe(1);
    expect(asFake(graph.trafficGain).disconnectCount).toBe(1);
    expect(asFake(graph.masterGain).disconnectCount).toBe(1);
  });
});
