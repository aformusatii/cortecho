import { describe, expect, it } from 'vitest';
import { CHIME_SAMPLE_RATE, chimePcm } from './chime.ts';
import { ReplyAudio } from './reply-audio.ts';

async function* chunk(buffer: Buffer): AsyncGenerator<Buffer> {
  yield buffer;
}

describe('test-sound chime', () => {
  it('is ~0.6 s of non-silent 48 kHz 16-bit mono', () => {
    const pcm = chimePcm();
    expect(CHIME_SAMPLE_RATE).toBe(48_000);
    expect(pcm.length).toBe(Math.round(CHIME_SAMPLE_RATE * 0.6) * 2);
    // Both tones are audible, but the fade-in starts at silence.
    expect(pcm.readInt16LE(0)).toBe(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeGreaterThan(0.3 * 32767);
  });

  it('serves as a WAV of about 600 ms through ReplyAudio', async () => {
    const reply = new ReplyAudio(chunk(chimePcm()), CHIME_SAMPLE_RATE);
    await reply.finished();
    expect(reply.sampleRate).toBe(48_000);
    expect(reply.durationMs).toBe(600);
  });
});
