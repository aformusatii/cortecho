/**
 * A tiny PCM WAV reader for the integration specs (the runner image does not
 * carry the app's audio module). Walks the chunks, so LIST/fact chunks are fine.
 */
export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Seconds of audio in the data chunk. */
  seconds: number;
  /** The raw PCM in the data chunk, for content checks (e.g. which tone). */
  pcm: Buffer;
};

export function parseWav(wav: Buffer): WavInfo {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: Omit<WavInfo, 'seconds' | 'pcm'> | null = null;
  let offset = 12;
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
      const bytes = Math.min(size, wav.length - body);
      return {
        ...fmt,
        seconds: bytes / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)),
        pcm: wav.subarray(body, body + bytes),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

/**
 * Cortecho streams a reply before its length is known, so the first header
 * carries 0xffffffff (RF64-style placeholder) sizes. The Echo plays it, but
 * OpenAI's transcription rejects it; rewrite RIFF/data from the real length.
 * Shared by the integration runner and the production smoke suite.
 */
export function withRealWavLengths(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString('latin1', 0, 4) !== 'RIFF') return wav;
  const fixed = Buffer.from(wav);
  fixed.writeUInt32LE(fixed.length - 8, 4);
  let offset = 12;
  while (offset + 8 <= fixed.length) {
    const id = fixed.toString('latin1', offset, offset + 4);
    if (id === 'data') {
      fixed.writeUInt32LE(fixed.length - offset - 8, offset + 4);
      break;
    }
    offset += 8 + fixed.readUInt32LE(offset + 4);
  }
  return fixed;
}
