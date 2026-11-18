/**
 * Energy-based end-of-speech detection for 16-bit mono PCM.
 *
 * In ESPHome mode Home Assistant's VAD normally ends a request; hassmic's own
 * end detection (setting "end_of_request") is experimental and off by
 * default. So this class decides when the user has finished, like HA's VAD,
 * plus a no-speech timeout and a maximum length. When the Echo does end a
 * request itself (end-of-audio), that simply comes first.
 *
 * - Audio is cut into 30 ms frames and each frame's RMS level (dBFS) is
 *   compared with max(minSpeechDb, noiseFloor + speechMarginDb).
 * - The noise floor adapts on non-speech frames. hassmic's gain can lift a
 *   quiet room by 30+ dB (a whispered wake word: +36 dB, room noise at
 *   -43 dBFS), so steady noise may start out above the threshold, where a
 *   floor that only learns from non-speech frames would never see it. So
 *   when the last 1.5 s were steady (every frame within 8 dB: a fan, the
 *   amplified room; speech swings far more) and above the floor, the floor
 *   jumps to that level and the audio so far is judged again with it.
 * - The silence timer starts only after real speech (≥ minSpeechMs), because
 *   the stream may open with a lead-in of silence.
 * - `startGuardMs`: in a follow-up the Echo plays its wake sound as the mic
 *   opens (hassmic's core_pipeline_finish, "wake sound, then it listens").
 *   The echo canceller leaves part of it in the stream, which is as loud as a
 *   quiet talker. Without the guard that sound counted as the answer, so 800 ms
 *   of room silence ended the follow-up at ~1.3 s instead of waiting the
 *   requested 8 s, and the real "yes" was never heard (2026-11-18).
 */

export type VadOptions = {
  sampleRate: number;
  minSpeechDb: number;
  speechMarginDb: number;
  minSpeechMs: number;
  endSilenceMs: number;
  noSpeechTimeoutMs: number;
  maxUtteranceMs: number;
  /**
   * Ignore speech for this long after the stream's leading digital silence
   * (hassmic's 800 ms lead-in), so the Echo's own wake sound cannot count as
   * the user's answer. 0/absent: no guard (a wake-word run starts with the
   * word itself, which must count).
   */
  startGuardMs?: number;
};

/** `listening` = keep feeding audio; anything else = stop. */
export type VadDecision = 'listening' | 'speech-ended' | 'no-speech' | 'max-length';

const FRAME_MS = 30;
const SILENCE_FLOOR_DB = -96;
/** How fast the noise floor follows quieter (fast) and louder (slow) frames. */
const FLOOR_FALL = 0.3;
const FLOOR_RISE = 0.02;

/** RMS level of 16-bit LE samples in dBFS (-96 for digital silence). */
export function frameDbfs(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return SILENCE_FLOOR_DB;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms)) : SILENCE_FLOOR_DB;
}

/** A window this long whose frames all lie within STEADY_SPREAD_DB is steady noise, not speech. */
const STEADY_WINDOW_FRAMES = Math.round(1500 / FRAME_MS);
const STEADY_SPREAD_DB = 8;
/** Raise the floor only when the window says it is this much too low (avoids constant re-judging). */
const FLOOR_CORRECTION_DB = 3;

export class EndOfSpeechDetector {
  private readonly options: VadOptions;
  private readonly frameBytes: number;
  private pendingBytes: Buffer = Buffer.alloc(0);
  private noiseFloorDb: number;
  /** Level of every frame so far (15 s at most: 500 numbers), to judge them again. */
  private readonly history: number[] = [];
  private speechRunMs = 0;
  private silenceRunMs = 0;
  private decision: VadDecision = 'listening';
  /** Where the stream's leading digital silence ends (hassmic's lead-in), null until then. */
  private liveStartMs: number | null = null;

  /** True once speech lasting at least `minSpeechMs` was heard. */
  speechHeard = false;
  /** Position (ms of audio) where the last speech frame ended. */
  speechEndAtMs = 0;
  /**
   * Position (ms of audio) of the last frame at or above the speech threshold,
   * **guard frames included**. The guard deliberately ignores speech, so this
   * is how the pipeline knows something was said in the opening window without
   * letting the VAD end the turn on it.
   */
  lastLoudAtMs = 0;

  constructor(options: VadOptions) {
    this.options = options;
    this.frameBytes = Math.round((options.sampleRate * FRAME_MS) / 1000) * 2;
    // Start by assuming a quiet room. Starting from the first frame instead
    // would treat a user who is already talking as "background noise".
    this.noiseFloorDb = options.minSpeechDb - options.speechMarginDb;
  }

  /** Feeds PCM and returns the decision so far. After a final decision, more audio changes nothing. */
  push(pcm: Buffer): VadDecision {
    if (this.decision !== 'listening') return this.decision;
    this.pendingBytes = this.pendingBytes.length === 0 ? pcm : Buffer.concat([this.pendingBytes, pcm]);

    while (this.pendingBytes.length >= this.frameBytes && this.decision === 'listening') {
      const frame = this.pendingBytes.subarray(0, this.frameBytes);
      this.pendingBytes = this.pendingBytes.subarray(this.frameBytes);
      this.processFrame(frameDbfs(frame));
    }
    return this.decision;
  }

  /** Silence since the last speech frame, in ms of audio. */
  get silenceMs(): number {
    return this.silenceRunMs;
  }

  get audioMs(): number {
    return this.history.length * FRAME_MS;
  }

  /** The current noise floor estimate in dBFS (for logs and tests). */
  get noiseFloor(): number {
    return this.noiseFloorDb;
  }

  /** Where the live stream begins (after hassmic's lead-in), null while it is all silence. */
  get liveStart(): number | null {
    return this.liveStartMs;
  }

  /** Audio position where the start guard ends: speech before it is not the answer. */
  get guardEndMs(): number {
    return this.liveStartMs === null ? 0 : this.liveStartMs + (this.options.startGuardMs ?? 0);
  }

  private threshold(): number {
    return Math.max(this.options.minSpeechDb, this.noiseFloorDb + this.options.speechMarginDb);
  }

  private processFrame(db: number): void {
    const endMs = (this.history.length + 1) * FRAME_MS;
    // hassmic opens a cold run with 800 ms of digital silence and only then the
    // mic stream (with its wake sound): the first other frame is "live".
    if (this.liveStartMs === null && db > SILENCE_FLOOR_DB) this.liveStartMs = endMs - FRAME_MS;
    this.history.push(db);
    // Anything loud, guard included: the pipeline checks the opening audio with
    // STT instead of relying on the (deliberately deaf) VAD there.
    if (db >= this.threshold()) this.lastLoudAtMs = endMs;
    // The guard frames stay in the history (the audio timeline must not shift:
    // trimming uses audio positions) but cannot start or continue speech.
    const guarded = this.liveStartMs !== null && endMs <= this.liveStartMs + (this.options.startGuardMs ?? 0);
    const isSpeech = guarded ? false : this.classify(db, endMs);
    if (!isSpeech) {
      // Only quiet frames teach us what "background" sounds like...
      const floor = this.noiseFloorDb;
      this.noiseFloorDb = floor + (db < floor ? FLOOR_FALL : FLOOR_RISE) * (db - floor);
    }
    // ...unless the last 1.5 s were a steady sound above the floor: that is
    // noise (speech always swings by far more), and the floor was too low.
    // A window still holding guard frames would call the Echo's wake sound
    // "the room", so wait until it is all live audio.
    const windowStartMs = endMs - STEADY_WINDOW_FRAMES * FRAME_MS;
    const windowIsLive =
      this.liveStartMs === null || windowStartMs >= this.liveStartMs + (this.options.startGuardMs ?? 0);
    if (windowIsLive && this.history.length >= STEADY_WINDOW_FRAMES) {
      let windowMin = Number.POSITIVE_INFINITY;
      let windowMax = Number.NEGATIVE_INFINITY;
      for (let i = this.history.length - STEADY_WINDOW_FRAMES; i < this.history.length; i++) {
        const v = this.history[i] ?? 0;
        windowMin = Math.min(windowMin, v);
        windowMax = Math.max(windowMax, v);
      }
      if (windowMax - windowMin <= STEADY_SPREAD_DB && windowMin > this.noiseFloorDb + FLOOR_CORRECTION_DB) {
        this.noiseFloorDb = windowMin;
        this.judgeAgain();
      }
    }
    this.decide();
  }

  /** Updates the speech/silence runs for one frame; returns whether it was speech. */
  private classify(db: number, endMs: number): boolean {
    const { minSpeechMs } = this.options;
    if (db >= this.threshold()) {
      this.speechRunMs += FRAME_MS;
      this.silenceRunMs = 0;
      if (this.speechRunMs >= minSpeechMs) this.speechHeard = true;
      this.speechEndAtMs = endMs;
      return true;
    }
    this.silenceRunMs += FRAME_MS;
    // A blip shorter than minSpeechMs followed by silence is not speech.
    if (!this.speechHeard) this.speechRunMs = 0;
    return false;
  }

  /** The floor moved up: what counted as speech may have been noise. */
  private judgeAgain(): void {
    const guardEndMs = (this.liveStartMs ?? 0) + (this.options.startGuardMs ?? 0);
    this.speechRunMs = 0;
    this.silenceRunMs = 0;
    this.speechHeard = false;
    this.speechEndAtMs = 0;
    this.history.forEach((db, i) => {
      const endMs = (i + 1) * FRAME_MS;
      // A guarded frame is the Echo's wake sound, never the answer.
      if (endMs > guardEndMs) this.classify(db, endMs);
    });
  }

  private decide(): void {
    const { endSilenceMs, noSpeechTimeoutMs, maxUtteranceMs } = this.options;
    const elapsedMs = this.audioMs;
    if (this.speechHeard && this.silenceRunMs >= endSilenceMs) {
      this.decision = 'speech-ended';
    } else if (!this.speechHeard && elapsedMs >= noSpeechTimeoutMs) {
      this.decision = 'no-speech';
    } else if (elapsedMs >= maxUtteranceMs) {
      this.decision = this.speechHeard ? 'max-length' : 'no-speech';
    }
  }
}
