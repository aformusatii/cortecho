/** Small PCM helpers. All audio here is 16-bit signed little-endian mono. */

/** Wraps raw PCM in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; pcm: Buffer };

/** Reads a PCM WAV file (walks the chunks, so extra LIST/fact chunks are fine). */
export function parseWav(wav: Buffer): WavInfo {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: Omit<WavInfo, 'pcm'> | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      return { ...fmt, pcm: wav.subarray(body, Math.min(body + size, wav.length)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

/**
 * Linear-interpolation resampler. Good enough for speech on a small speaker;
 * it avoids pulling in a DSP dependency. Keeps state between calls so a
 * stream can be resampled chunk by chunk without clicks at the seams.
 */
export class LinearResampler {
  private readonly ratio: number;
  private position = 0;
  private previous: number | null = null;
  private carry: Buffer = Buffer.alloc(0);

  constructor(fromRate: number, toRate: number) {
    this.ratio = fromRate / toRate;
  }

  push(chunk: Buffer): Buffer {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const sampleCount = Math.floor(data.length / 2);
    this.carry = data.subarray(sampleCount * 2);
    if (sampleCount === 0) return Buffer.alloc(0);

    // Prepend the last sample of the previous chunk, so interpolation across
    // the chunk boundary has both neighbours.
    const offset = this.previous === null ? 0 : 1;
    const input = new Int16Array(sampleCount + offset);
    if (this.previous !== null) input[0] = this.previous;
    for (let i = 0; i < sampleCount; i++) input[i + offset] = data.readInt16LE(i * 2);

    const output: number[] = [];
    while (this.position + 1 < input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      output.push(Math.round((input[index] ?? 0) * (1 - fraction) + (input[index + 1] ?? 0) * fraction));
      this.position += this.ratio;
    }
    // Rebase the read position onto the next chunk (whose index 0 = our last sample).
    this.position -= input.length - 1;
    this.previous = input[input.length - 1] ?? 0;

    const out = Buffer.alloc(output.length * 2);
    output.forEach((sample, i) => {
      out.writeInt16LE(sample, i * 2);
    });
    return out;
  }
}

/** Re-chunks a byte stream into pieces of exactly `size` bytes (the last one may be shorter). */
export async function* rechunk(source: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
  // Never split a 16-bit sample.
  const even = pending.length - (pending.length % 2);
  if (even > 0) yield pending.subarray(0, even);
}

/** Duration in ms of 16-bit mono PCM. */
export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return Math.round((bytes / 2 / sampleRate) * 1000);
}
