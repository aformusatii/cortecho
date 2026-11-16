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
 */

export type VadOptions = {
  sampleRate: number;
  minSpeechDb: number;
  speechMarginDb: number;
  minSpeechMs: number;
  endSilenceMs: number;
  noSpeechTimeoutMs: number;
  maxUtteranceMs: number;
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

  /** True once speech lasting at least `minSpeechMs` was heard. */
  speechHeard = false;
  /** Position (ms of audio) where the last speech frame ended. */
  speechEndAtMs = 0;

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

  private threshold(): number {
    return Math.max(this.options.minSpeechDb, this.noiseFloorDb + this.options.speechMarginDb);
  }

  private processFrame(db: number): void {
    this.history.push(db);
    const isSpeech = this.classify(db, this.history.length * FRAME_MS);
    if (!isSpeech) {
      // Only quiet frames teach us what "background" sounds like...
      const floor = this.noiseFloorDb;
      this.noiseFloorDb = floor + (db < floor ? FLOOR_FALL : FLOOR_RISE) * (db - floor);
    }
    // ...unless the last 1.5 s were a steady sound above the floor: that is
    // noise (speech always swings by far more), and the floor was too low.
    if (this.history.length >= STEADY_WINDOW_FRAMES) {
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
    this.speechRunMs = 0;
    this.silenceRunMs = 0;
    this.speechHeard = false;
    this.speechEndAtMs = 0;
    this.history.forEach((db, i) => {
      this.classify(db, (i + 1) * FRAME_MS);
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
