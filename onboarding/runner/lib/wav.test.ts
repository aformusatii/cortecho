import { describe, expect, it } from 'vitest';
import { parseWav, withRealWavLengths } from './wav.ts';

/** The header Cortecho streams before the reply length is known. */
function streamedReply(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0xffffffff - 36, 40);
  return Buffer.concat([header, pcm]);
}

describe('withRealWavLengths', () => {
  it('rewrites the placeholder RIFF and data sizes to the bytes received', () => {
    const pcm = Buffer.alloc(48_000, 1); // 1 s at 24 kHz, mono, 16-bit
    const fixed = withRealWavLengths(streamedReply(pcm));
    expect(fixed.readUInt32LE(4)).toBe(fixed.length - 8);
    expect(fixed.readUInt32LE(40)).toBe(pcm.length);
    expect(parseWav(fixed).seconds).toBeCloseTo(1, 5);
  });

  it('leaves a valid WAV and a non-WAV buffer unchanged', () => {
    const pcm = Buffer.alloc(1_000, 2);
    const valid = Buffer.from(streamedReply(pcm));
    valid.writeUInt32LE(valid.length - 8, 4);
    valid.writeUInt32LE(pcm.length, 40);
    expect(withRealWavLengths(valid).equals(valid)).toBe(true);

    const notWav = Buffer.from('not a wav');
    expect(withRealWavLengths(notWav)).toBe(notWav);
  });
});
