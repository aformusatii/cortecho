import { randomBytes } from 'node:crypto';
import { createLogger, errorMessage } from '../lib/logger.ts';

const log = createLogger('reply-audio');

/**
 * The spoken reply, served to the Echo over HTTP. hassmic does not take
 * streamed TTS over the API connection: like Home Assistant we give it a URL
 * (TTS_END / announcement) and it downloads the audio (WAV or MP3 only).
 *
 * The PCM is buffered as TTS produces it, and a download that starts early
 * follows the stream, so playback starts after the first chunk instead of
 * after the whole answer. Each reply has an id of 128 random bits and expires
 * after `ttlMs`; with several Echos there is one current reply per device.
 */
export class ReplyAudio {
  readonly id = randomBytes(16).toString('base64url');
  readonly sampleRate: number;
  readonly createdAtMs = Date.now();
  private readonly chunks: Buffer[] = [];
  private waiters: (() => void)[] = [];
  bytes = 0;
  done = false;
  error: Error | null = null;
  /** Set when the first download starts (for the "played" timeout). */
  firstFetchAtMs: number | null = null;

  constructor(source: AsyncIterable<Buffer>, sampleRate: number) {
    this.sampleRate = sampleRate;
    void this.pump(source);
  }

  /** Audio length so far, in ms. */
  get durationMs(): number {
    return Math.round((this.bytes / 2 / this.sampleRate) * 1000);
  }

  /**
   * Resolves once `prebufferMs` of audio is there (or the stream ended);
   * rejects if TTS failed before any audio.
   *
   * hassmic plays what it downloads as it arrives, without a buffer of its
   * own, and OpenAI's TTS sends 200 ms of audio, then nothing for 260-560 ms
   * (measured 2026-11-13; after that it stays far ahead of real time). A reply
   * handed over at its first chunk went silent 200 ms in, for up to 200 ms.
   */
  async ready(prebufferMs = 0): Promise<void> {
    const wanted = Math.max(1, Math.round((prebufferMs / 1000) * this.sampleRate) * 2);
    while (this.bytes < wanted && !this.done) await this.next();
    if (this.chunks.length === 0) throw this.error ?? new Error('TTS returned no audio');
  }

  /** Resolves when the whole reply has been generated. */
  async finished(): Promise<void> {
    while (!this.done) await this.next();
  }

  /** The WAV file: header, then the PCM as it arrives. Several readers may follow the same reply. */
  async *wav(): AsyncGenerator<Buffer> {
    this.firstFetchAtMs ??= Date.now();
    // The length is not known yet: hassmic (and browsers) read a WAV until the
    // connection ends, so the maximum stands in for "streaming".
    yield wavHeader(this.sampleRate, this.done ? this.bytes : 0xffffffff - 36);
    let index = 0;
    for (;;) {
      while (index < this.chunks.length) {
        const chunk = this.chunks[index++];
        if (chunk) yield chunk;
      }
      if (this.done) return;
      await this.next();
    }
  }

  private next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private async pump(source: AsyncIterable<Buffer>): Promise<void> {
    let carry: Buffer | null = null;
    try {
      for await (const chunk of source) {
        // Never hand out half a sample.
        const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        const even = data.length - (data.length % 2);
        carry = even < data.length ? data.subarray(even) : null;
        if (even === 0) continue;
        this.chunks.push(data.subarray(0, even));
        this.bytes += even;
        this.wake();
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      log.warn(`TTS stream failed after ${this.bytes} bytes: ${errorMessage(error)}`);
    } finally {
      this.done = true;
      this.wake();
    }
  }
}

/**
 * Holds the current reply of every Echo. A pipeline revokes its previous
 * reply when it starts a new one and on stop; a deleted or replaced device
 * revokes its reply too, so a dead device's audio is never served.
 */
export class ReplyAudioStore {
  private readonly current = new Map<string, ReplyAudio>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Starts serving a new reply (the caller revokes its device's previous one). */
  create(source: AsyncIterable<Buffer>, sampleRate: number): ReplyAudio {
    this.sweep();
    const reply = new ReplyAudio(source, sampleRate);
    this.current.set(reply.id, reply);
    return reply;
  }

  /** The reply with this id, if it has not expired. */
  get(id: string): ReplyAudio | null {
    const reply = this.current.get(id);
    if (!reply) return null;
    if (Date.now() - reply.createdAtMs > this.ttlMs) {
      this.current.delete(id);
      return null;
    }
    return reply;
  }

  /** Ends serving `reply`. */
  revoke(reply: ReplyAudio): void {
    this.current.delete(reply.id);
  }

  /** How many replies are being served (tests, diagnostics). */
  get size(): number {
    return this.current.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, reply] of this.current) {
      if (now - reply.createdAtMs > this.ttlMs) this.current.delete(id);
    }
  }
}

function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
