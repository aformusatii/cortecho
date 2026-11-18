import { describe, expect, it } from 'vitest';
import { syntheticSpeech } from '../esphome/fake-echo.ts';
import { EndOfSpeechDetector, frameDbfs, type VadOptions } from './end-of-speech.ts';

const OPTIONS: VadOptions = {
  sampleRate: 16000,
  minSpeechDb: -50,
  speechMarginDb: 12,
  minSpeechMs: 150,
  endSilenceMs: 800,
  noSpeechTimeoutMs: 8000,
  maxUtteranceMs: 15000,
};

const silence = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * 16000) * 2);

/** Feeds PCM in 32 ms chunks (like hassmic) and returns the first final decision. */
function run(pcm: Buffer, options: VadOptions = OPTIONS) {
  const vad = new EndOfSpeechDetector(options);
  for (let offset = 0; offset < pcm.length; offset += 1024) {
    const decision = vad.push(pcm.subarray(offset, offset + 1024));
    if (decision !== 'listening') return { decision, atMs: vad.audioMs, vad };
  }
  return { decision: 'listening' as const, atMs: vad.audioMs, vad };
}

describe('frameDbfs', () => {
  it('is -96 for digital silence and about -3 for a full-scale sine', () => {
    expect(frameDbfs(silence(30))).toBe(-96);
    const sine = Buffer.alloc(960);
    for (let i = 0; i < 480; i++)
      sine.writeInt16LE(Math.round(32767 * Math.sin((2 * Math.PI * i) / 48)), i * 2);
    expect(frameDbfs(sine)).toBeCloseTo(-3, 0);
  });
});

describe('EndOfSpeechDetector', () => {
  it('ends ~endSilenceMs after speech stops, not during the lead-in silence', () => {
    const pcm = syntheticSpeech({ leadSilenceMs: 2000, speechMs: 1000, trailSilenceMs: 2000 });
    const { decision, atMs, vad } = run(pcm);
    expect(decision).toBe('speech-ended');
    expect(vad.speechHeard).toBe(true);
    // speech ends at 3000 ms; + 800 ms silence (one frame of slack each way)
    expect(atMs).toBeGreaterThanOrEqual(3780);
    expect(atMs).toBeLessThanOrEqual(3900);
  });

  it('reports no-speech after the timeout when nobody talks', () => {
    const { decision, atMs } = run(silence(10_000));
    expect(decision).toBe('no-speech');
    expect(atMs).toBeGreaterThanOrEqual(8000);
    expect(atMs).toBeLessThan(8100);
  });

  it('ignores a click shorter than minSpeechMs', () => {
    const click = syntheticSpeech({ leadSilenceMs: 500, speechMs: 60, trailSilenceMs: 9000 });
    expect(run(click).decision).toBe('no-speech');
  });

  it('stops at maxUtteranceMs when the user never pauses', () => {
    const pcm = syntheticSpeech({ leadSilenceMs: 0, speechMs: 16_000, trailSilenceMs: 0 });
    const { decision, atMs } = run(pcm);
    expect(decision).toBe('max-length');
    expect(atMs).toBeGreaterThanOrEqual(15000);
  });

  it('detects a user who is already talking in the first frame', () => {
    expect(run(syntheticSpeech({ leadSilenceMs: 0, speechMs: 800, trailSilenceMs: 1200 })).decision).toBe(
      'speech-ended',
    );
  });

  it('adapts to a constant noise floor above minSpeechDb', () => {
    // Steady noise around -40 dBFS must not count as speech forever.
    const noise = Buffer.alloc(16000 * 2 * 10);
    for (let i = 0; i < noise.length / 2; i++)
      noise.writeInt16LE(Math.round((Math.random() - 0.5) * 0.035 * 32767), i * 2);
    expect(frameDbfs(noise.subarray(0, 960))).toBeGreaterThan(-50);
    const { decision, atMs } = run(noise);
    expect(decision).toBe('no-speech');
    expect(atMs).toBeLessThan(8100);
  });

  /** Uniform noise at roughly `db` dBFS RMS. */
  function noiseAt(db: number, ms: number): Buffer {
    const amplitude = 10 ** (db / 20) * Math.sqrt(12);
    const pcm = Buffer.alloc(Math.round((ms / 1000) * 16000) * 2);
    for (let i = 0; i < pcm.length / 2; i++)
      pcm.writeInt16LE(Math.round((Math.random() - 0.5) * amplitude * 32767), i * 2);
    return pcm;
  }

  /** Adds two PCM buffers sample by sample (clipped). */
  function mix(a: Buffer, b: Buffer): Buffer {
    const out = Buffer.alloc(Math.min(a.length, b.length));
    for (let i = 0; i < out.length / 2; i++)
      out.writeInt16LE(Math.max(-32768, Math.min(32767, a.readInt16LE(i * 2) + b.readInt16LE(i * 2))), i * 2);
    return out;
  }

  it('ends a quiet request that the Echo amplified with its room noise (seen live: noise -43 dBFS)', () => {
    // Whispered wake word: hassmic's gain +36 dB lifts the room to about -43 dBFS.
    const speech = syntheticSpeech({
      leadSilenceMs: 300,
      speechMs: 1500,
      trailSilenceMs: 3000,
      amplitude: 0.1,
    });
    const pcm = mix(speech, noiseAt(-43, 4800));
    const { decision, atMs, vad } = run(pcm);
    expect(decision).toBe('speech-ended');
    expect(atMs).toBeLessThan(3500); // speech ends at 1800 ms; well before max length
    expect(vad.noiseFloor).toBeGreaterThan(-47);
  });

  it('does not take amplified room noise alone for speech', () => {
    const { decision, vad } = run(noiseAt(-43, 10_000));
    expect(decision).toBe('no-speech');
    expect(vad.speechHeard).toBe(false);
  });

  describe("the Echo's wake sound at the start of a follow-up", () => {
    // What hassmic sends: 800 ms of digital silence (lead_in), then the mic
    // stream opening with the wake sound (stock ui_wakesound, 650 ms) and its
    // echo tail — measured to ~760 ms of live audio on 2026-11-18.
    const followUpStart = () =>
      Buffer.concat([
        silence(800),
        syntheticSpeech({ leadSilenceMs: 0, speechMs: 760, trailSilenceMs: 0, amplitude: 0.3 }),
      ]);
    const room = (ms: number) => syntheticSpeech({ leadSilenceMs: 0, speechMs: 0, trailSilenceMs: ms });
    const answer = () =>
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 400, trailSilenceMs: 0, amplitude: 0.3 });
    const followUp: VadOptions = { ...OPTIONS, startGuardMs: 2000, noSpeechTimeoutMs: 3000 };

    it('does not end a follow-up on the wake sound and its echo tail', () => {
      const { decision, vad } = run(Buffer.concat([followUpStart(), room(9000)]), followUp);
      expect(decision).toBe('no-speech');
      expect(vad.speechHeard).toBe(false);
    });

    it('records loud audio inside the guard without counting it as speech', () => {
      const pcm = Buffer.concat([followUpStart(), room(200), answer(), room(9000)]);
      const { decision, vad } = run(pcm, followUp);
      expect(decision).toBe('no-speech');
      expect(vad.speechHeard).toBe(false);
      // The answer (live 960-1360 ms) is past the Echo's sound, so the pipeline
      // can find it with STT; it must not be loud enough to end the turn.
      expect(vad.liveStart).toBeGreaterThanOrEqual(770);
      expect(vad.liveStart).toBeLessThanOrEqual(810);
      expect(vad.lastLoudAtMs).toBeGreaterThan((vad.liveStart ?? 0) + 900);
    });

    it('hears an answer given after the guard', () => {
      const pcm = Buffer.concat([followUpStart(), room(1400), answer(), room(1500)]);
      // The whole wait must outlast the 2 s guard: the no-speech timeout counts
      // from the start of the audio, guard included.
      const { decision, vad } = run(pcm, { ...followUp, noSpeechTimeoutMs: 5000 });
      expect(decision).toBe('speech-ended');
      expect(vad.speechHeard).toBe(true);
    });

    it('without the guard the wake sound ends it after 800 ms of silence (the first failure)', () => {
      const { decision, atMs } = run(Buffer.concat([followUpStart(), room(9000)]), {
        ...OPTIONS,
        noSpeechTimeoutMs: 3000,
      });
      expect(decision).toBe('speech-ended');
      // 800 ms lead-in + 760 ms sound + 800 ms silence
      expect(atMs).toBeLessThan(2500);
    });

    it('a 650 ms guard leaves the echo tail as speech (the second failure)', () => {
      const { decision } = run(Buffer.concat([followUpStart(), room(9000)]), {
        ...OPTIONS,
        startGuardMs: 650,
        noSpeechTimeoutMs: 3000,
      });
      expect(decision).toBe('speech-ended');
    });
  });
});
