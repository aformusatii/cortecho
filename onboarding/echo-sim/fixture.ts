import { readFileSync } from 'node:fs';
import { LinearResampler, parseWav } from '../../apps/api/src/pipeline/audio.ts';

/**
 * The spoken request as the Echo's mic hears it. The fixture is a 16 kHz mono
 * WAV; it is normalised to the smoke suite's speech level and given the same
 * room noise. FakeEcho itself prepends the 800 ms lead-in and the wake chime,
 * and streams room audio after the request (timing: 'real').
 */

const MIC_RATE = 16_000;

export type FixtureOptions = {
  /** Speech RMS in dBFS (smoke default -26). */
  speechDb: number;
  /** Room noise RMS in dBFS (smoke default -60). */
  roomDb: number;
};

export function loadFixture(file: string, options: FixtureOptions): Buffer {
  const info = parseWav(readFileSync(file));
  const mono = info.channels === 1 ? info.pcm : downmixToMono(info.pcm, info.channels);
  const pcm = info.sampleRate === MIC_RATE ? mono : new LinearResampler(info.sampleRate, MIC_RATE).push(mono);
  return addNoise(scaleToDbFs(pcm, options.speechDb), options.roomDb);
}

function rms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (pcm.length / 2));
}

/** Scales the RMS of `pcm` to `targetDb` dBFS (clamped to the 16-bit range). */
function scaleToDbFs(pcm: Buffer, targetDb: number): Buffer {
  const current = rms(pcm);
  if (current <= 0) return Buffer.from(pcm);
  const targetRms = 32768 * 10 ** (targetDb / 20);
  const factor = targetRms / current;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor)));
    out.writeInt16LE(value, i);
  }
  return out;
}

/** Adds room noise at `roomDb` dBFS (a sum of three uniforms ≈ Gaussian). */
function addNoise(pcm: Buffer, roomDb: number): Buffer {
  const targetRms = 32768 * 10 ** (roomDb / 20);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const noise = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const value = Math.max(-32768, Math.min(32767, pcm.readInt16LE(i) + Math.round(noise * targetRms)));
    out.writeInt16LE(value, i);
  }
  return out;
}

/** Keeps the first channel of interleaved multi-channel PCM. */
function downmixToMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const samples = Math.floor(pcm.length / 2 / channels);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(pcm.readInt16LE(i * 2 * channels), i * 2);
  return out;
}
