/**
 * The chime the setup wizard plays on an Echo to identify it (spec §7.5).
 * Generated here so the app ships no audio asset: a two-tone sine,
 * 48 kHz, 16-bit mono, ~0.6 s. ReplyAudio adds the WAV header.
 */

export const CHIME_SAMPLE_RATE = 48_000;

const FADE_S = 0.008;
const TONES: { hz: number; seconds: number }[] = [
  { hz: 660, seconds: 0.28 },
  { hz: 880, seconds: 0.32 },
];

/** The chime as PCM (little-endian 16-bit mono), ready for ReplyAudio. */
export function chimePcm(): Buffer {
  const tones = TONES.map((tone) => ({ ...tone, frames: Math.round(CHIME_SAMPLE_RATE * tone.seconds) }));
  const pcm = Buffer.alloc(tones.reduce((sum, tone) => sum + tone.frames, 0) * 2);
  let offset = 0;
  const fadeFrames = Math.max(1, Math.round(CHIME_SAMPLE_RATE * FADE_S));
  for (const { hz, frames } of tones) {
    for (let i = 0; i < frames; i++) {
      // Fade in and out of every tone (and of the whole chime) so the speaker
      // does not click; the short dip is part of the character of a chime.
      const edge = Math.min(i, frames - 1 - i) / fadeFrames;
      const envelope = Math.min(1, edge);
      const value = Math.sin((2 * Math.PI * hz * i) / CHIME_SAMPLE_RATE) * envelope * 0.35;
      pcm.writeInt16LE(Math.round(value * 32767), offset);
      offset += 2;
    }
  }
  return pcm;
}
