import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI, { toFile } from 'openai';
import { LinearResampler, parseWav, pcmToWav } from '../../apps/api/src/pipeline/audio.ts';
import type { SmokeEnv } from './env.ts';

/**
 * The owner's voice (spec §5): OpenAI TTS of the requests (with a disk cache)
 * and transcription of the replies, both with the suite's own key. Speech is
 * shaped to sound like the Echo's mic — normalised to SMOKE_SPEECH_DBFS with
 * room noise at SMOKE_ROOM_DBFS — so Cortecho's VAD hears what a real room
 * would give it.
 */

const SMOKE_DIR = fileURLToPath(new URL('..', import.meta.url));
const TTS_CACHE_DIR = path.join(SMOKE_DIR, '.cache', 'tts');
/** OpenAI's `pcm` speech format: 24 kHz, mono, s16le. */
const OPENAI_PCM_RATE = 24_000;
const MIC_RATE = 16_000;

export type WakeInput = string | { wav: Buffer; pauseMs?: number; noiseDb?: number };

export class OwnerVoice {
  private readonly client: OpenAI;
  readonly env: SmokeEnv;

  constructor(env: SmokeEnv) {
    this.env = env;
    this.client = new OpenAI({
      apiKey: env.SMOKE_OPENAI_API_KEY,
      baseURL: env.SMOKE_OPENAI_BASE_URL,
      maxRetries: 1,
    });
  }

  /**
   * The 16 kHz mono s16le PCM of `text`, as the Echo's mic would capture it:
   * cached by a hash of the model, voice, instructions and text, then shaped.
   */
  async micPcm(text: string): Promise<Buffer> {
    return this.shape(parseWav(await this.ttsWav(text)).pcm);
  }

  /** The shaped PCM of a test's own WAV (a real recording, another language…). */
  shapedWav(wav: Buffer, { noiseDb }: { noiseDb?: number } = {}): Buffer {
    const info = parseWav(wav);
    const mono = info.channels === 1 ? info.pcm : downmixToMono(info.pcm, info.channels);
    const pcm =
      info.sampleRate === MIC_RATE ? mono : new LinearResampler(info.sampleRate, MIC_RATE).push(mono);
    return this.shape(pcm, { noiseDb });
  }

  /** Normalise to SMOKE_SPEECH_DBFS and add room noise at SMOKE_ROOM_DBFS. */
  private shape(pcm: Buffer, { noiseDb = this.env.SMOKE_ROOM_DBFS } = {}): Buffer {
    return addNoise(scaleToDbFs(pcm, this.env.SMOKE_SPEECH_DBFS), noiseDb);
  }

  /** The reply's text, transcribed with the suite's key (spec §5.3). */
  async transcribe(replyWav: Buffer): Promise<string> {
    const file = await toFile(replyWav, 'reply.wav', { type: 'audio/wav' });
    const result = await this.client.audio.transcriptions.create({
      model: this.env.SMOKE_TRANSCRIBE_MODEL,
      file,
      response_format: 'json',
    });
    return result.text.trim();
  }

  /** Cached TTS: 16 kHz mono s16le WAV of `text`. */
  private async ttsWav(text: string): Promise<Buffer> {
    const key = createHash('sha256')
      .update(
        [
          this.env.SMOKE_TTS_MODEL,
          this.env.SMOKE_TTS_VOICE,
          this.env.SMOKE_TTS_INSTRUCTIONS ?? '',
          text,
        ].join('\n'),
      )
      .digest('hex');
    const cachePath = path.join(TTS_CACHE_DIR, `${key}.wav`);
    if (existsSync(cachePath)) return readFileSync(cachePath);
    const wav = pcmToWav(await this.synthesize(text), MIC_RATE);
    mkdirSync(TTS_CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, wav);
    return wav;
  }

  /** OpenAI TTS as 16 kHz mono s16le PCM (the API yields 24 kHz). */
  private async synthesize(text: string): Promise<Buffer> {
    const response = await this.client.audio.speech.create({
      model: this.env.SMOKE_TTS_MODEL,
      voice: this.env.SMOKE_TTS_VOICE,
      input: text,
      response_format: 'pcm',
      ...(this.env.SMOKE_TTS_INSTRUCTIONS ? { instructions: this.env.SMOKE_TTS_INSTRUCTIONS } : {}),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return new LinearResampler(OPENAI_PCM_RATE, MIC_RATE).push(Buffer.concat(chunks));
  }
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
