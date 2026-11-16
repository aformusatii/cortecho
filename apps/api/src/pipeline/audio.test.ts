import { describe, expect, it } from 'vitest';
import { LinearResampler, parseWav, pcmToWav, rechunk } from './audio.ts';

describe('WAV', () => {
  it('round-trips PCM through a WAV header', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.length).toBe(44 + 6);
    expect(parseWav(wav)).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16, pcm });
  });
});

describe('LinearResampler', () => {
  it('produces the expected number of samples across chunk boundaries', () => {
    const input = Buffer.alloc(24000 * 2); // 1 s at 24 kHz
    const resampler = new LinearResampler(24000, 16000);
    let total = 0;
    for (let offset = 0; offset < input.length; offset += 1001)
      total += resampler.push(input.subarray(offset, offset + 1001)).length;
    expect(Math.abs(total / 2 - 16000)).toBeLessThanOrEqual(2);
  });

  it('keeps a constant signal constant', () => {
    const input = Buffer.alloc(2400);
    for (let i = 0; i < 1200; i++) input.writeInt16LE(1000, i * 2);
    const out = new LinearResampler(24000, 22050).push(input);
    for (let i = 0; i < out.length / 2; i++) expect(out.readInt16LE(i * 2)).toBe(1000);
  });
});

describe('rechunk', () => {
  it('yields fixed-size pieces and an even-length remainder', async () => {
    async function* source() {
      yield Buffer.alloc(5);
      yield Buffer.alloc(10);
    }
    const sizes: number[] = [];
    for await (const chunk of rechunk(source(), 4)) sizes.push(chunk.length);
    expect(sizes).toEqual([4, 4, 4, 2]);
  });
});
