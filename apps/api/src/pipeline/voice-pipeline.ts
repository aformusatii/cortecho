import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PipelineState,
  Settings,
  ToolCallRecord,
  Turn,
  TurnOutcome,
  TurnSource,
  TurnTimings,
  VoicePreview,
} from '@cortecho/shared';
import type { Config } from '../config.ts';
import type { EsphomeClient } from '../esphome/client.ts';
import { VA_EVENT, type VoiceAssistantAudio, type VoiceAssistantRequest } from '../esphome/messages.ts';
import type { SettingsSnapshot } from '../features/settings/settings-store.ts';
import type { TurnsRepository } from '../features/turns/turns.repository.ts';
import { createLogger, errorMessage } from '../lib/logger.ts';
import type { ToolRegistry, ToolSet } from '../tools/registry.ts';
import { EndOfSpeechDetector, type VadOptions } from '../vad/end-of-speech.ts';
import type { AgentSessions } from './agent-sessions.ts';
import { LinearResampler, pcmDurationMs, pcmToWav } from './audio.ts';
import type { PromptDevice } from './prompt-layers.ts';
import type { ReplyAudio, ReplyAudioStore } from './reply-audio.ts';
import { firstSentence, headThenRest } from './reply-speech.ts';
import type { VoiceServices } from './services.ts';

const log = createLogger('pipeline');

/** The Echo's mic format (ESPHome voice assistant audio: 16 kHz, 16-bit, mono). */
const MIC_RATE = 16_000;
/**
 * Wall-clock bound on listening, on top of the VAD's maximum length (which
 * counts audio): if the Echo's mic stream stalls, the turn must still end.
 */
const LISTEN_GRACE_MS = 5000;
/** Audio kept after the last speech frame when the utterance is cut for transcription. */
const SPEECH_TAIL_MS = 300;
/** A run that starts this soon after an answer with continue_conversation is its follow-up. */
const FOLLOW_UP_WINDOW_MS = 15_000;
/**
 * Upper bound on a follow-up's listening (wait + answer). hassmic gives up
 * after 30 s in LISTENING (PIPELINE_TIMEOUT in main.c); this leaves room for
 * its lead-in and our transcription start.
 */
const FOLLOW_UP_LISTEN_LIMIT_MS = 27_000;
/**
 * The Echo plays its wake sound (stock ui_wakesound: 650 ms) as a follow-up
 * opens the mic, and the echo canceller leaves part of it in the stream. It is
 * not the user's answer: ignore speech for this long after hassmic's 800 ms
 * lead-in.
 *
 * 650 ms was the sound's own length and too short: the residual plus the room's
 * tail lasted ~760 ms, and the 110 ms past the guard was enough for minSpeechMs
 * (150 ms over a couple of frames), so 800 ms of room silence ended the
 * follow-up at 1.57 s again (2026-11-18, second occurrence). A real answer in
 * the same log ended 1.27-1.60 s into the live audio, so 1000 ms covered the
 * sound with margin.
 *
 * The owner asked for a longer, certain guard: 2 s with no VAD decision at all,
 * and no audio blind spot. The VAD stays deaf for the 2 s exactly as asked;
 * `checkOpening` below covers that window with STT, so an answer given inside
 * the guard is still heard (answers after it are the VAD's).
 */
const FOLLOW_UP_START_GUARD_MS = 2000;
/**
 * Live-audio position where the Echo's own wake sound (650 ms) and its measured
 * echo tail (to ~760 ms) are over. Loud audio past this, inside the guard, is
 * the user, not the sound: that is what `checkOpening` transcribes.
 */
const WAKE_SOUND_TAIL_MS = 900;

export type PipelineOptions = {
  client: EsphomeClient;
  services: VoiceServices;
  turns: TurnsRepository;
  replies: ReplyAudioStore;
  /** Deployment bits that are not settings: reply URL base and debug audio. */
  config: Pick<Config, 'reply' | 'debug'>;
  /**
   * The settings this pipeline's turns run with. One snapshot per turn: a
   * change mid-turn applies from the next one.
   */
  settings: () => SettingsSnapshot;
  /** Conversation memory shared by every runtime (one map; keyed per speaker). */
  sessions: AgentSessions;
  /** The Echo behind this pipeline (null only for an /api/ask without a device). */
  deviceId: number | null;
  /** That Echo's current name and owner-written prompt (layer 3), read per request. */
  device: () => PromptDevice | null;
  /** Base of the reply URLs when REPLY_AUDIO_BASE_URL is empty (server.ts derives it from the link). */
  fallbackReplyBaseUrl?: () => string;
  /** The tool registry: the turn's ToolSet is frozen from it at the start. */
  tools: ToolRegistry;
};

/** Raised by /api/say when it cannot speak right now. */
export class EchoUnavailableError extends Error {
  readonly code: 'ECHO_UNAVAILABLE' | 'ECHO_BUSY';
  constructor(code: 'ECHO_UNAVAILABLE' | 'ECHO_BUSY', message: string) {
    super(message);
    this.name = 'EchoUnavailableError';
    this.code = code;
  }
}

type Phase = 'listening' | 'thinking' | 'speaking';

/** A transcription started during a pause, before the VAD ended the utterance. */
type EagerTranscript = {
  /** Where the speech ended when it started; it is only valid while that still holds. */
  speechEndAtMs: number;
  /** Never rejects. */
  result: Promise<{ text: string } | { error: unknown }>;
};

type ActiveTurn = import('@cortecho/shared').SearchDisplay & {
  source: TurnSource;
  startedAt: Date;
  startedAtMs: number;
  abort: AbortController;
  timings: TurnTimings;
  transcript: string | null;
  reply: string | null;
  toolCalls: ToolCallRecord[];
  phase: Phase;
  finished: boolean;
  /** RUN_END (or an announcement) went out: the Echo owns the turn now, we only wait for playback. */
  handedOver: boolean;
  /** The Echo aborted the run (start=false) or the link dropped: send nothing more for it. */
  silenced: boolean;
  followUp: boolean;
  /** The snapshot this turn runs with, taken when it started. */
  settings: Settings;
  /** The tools offered for this turn, frozen at its start. */
  toolSet: ToolSet;
  settingsVersion: number;
  /** Which conversation memory this turn uses ('voice', 'web'; later 'device:<id>'). */
  sessionKey: string;
  // Voice turns only:
  vad: EndOfSpeechDetector | null;
  audio: Buffer[];
  eager: EagerTranscript | null;
  /** Text already transcribed in the follow-up's opening check; skips the final STT. */
  forcedText?: string;
  /** The follow-up opening was checked (one check per turn, right or wrong). */
  openingChecked?: boolean;
  /** The opening check is still transcribing; hold the no-speech end until it says. */
  openingChecking?: boolean;
  /** The wait expired while the opening check ran: end when it resolves with nothing. */
  pendingNoSpeech?: boolean;
  /** Listening: the wall-clock bound. After that: no reply handed over in time. */
  deadline: NodeJS.Timeout | null;
  /** The turn deadline as a timestamp, for connector call budgets. */
  deadlineAtMs: number | null;
};

/**
 * Drives one conversation turn at a time over the ESPHome API, the way Home
 * Assistant's esphome assist satellite does it for hassmic:
 *
 *   ← VoiceAssistantRequest(start)        → VoiceAssistantResponse, RUN_START, STT_START
 *   ← VoiceAssistantAudio…                 our VAD hears the end (or the Echo sends end=true
 *                                            when its experimental end_of_request is on)
 *                                          → STT_VAD_END (mic off, "thinking")
 *     STT (started in the pause already)   → STT_END{text}, INTENT_START
 *     agent (+tools); TTS starts on the
 *     first sentence, while the agent
 *     writes the rest                      → INTENT_END{continue_conversation}, TTS_START{text},
 *                                            TTS_END{url}, RUN_END
 *   ← GET <url> (the reply as WAV)
 *   ← VoiceAssistantAnnounceFinished       (hassmic plays replies like announcements)
 *
 * Every path out of a turn ends with RUN_END or ERROR, so the Echo never
 * stays listening or thinking. `stt-no-text-recognized` ends quietly; other
 * error codes play the error sound.
 */
export class VoicePipeline {
  private readonly options: PipelineOptions;
  private turn: ActiveTurn | null = null;
  private playbackWaiter: ((success: boolean) => void) | null = null;
  private followUpUntilMs = 0;
  /** How long the next follow-up run waits for the user to start talking (null = VAD default). */
  private followUpWaitMs: number | null = null;
  /** This device's current reply, revoked when it starts the next one or on stop. */
  private currentReply: ReplyAudio | null = null;

  state: PipelineState = 'idle';
  lastTurn: Turn | null = null;

  constructor(options: PipelineOptions) {
    this.options = options;
    const { client } = options;
    client.on('voice-request', (request) => this.onVoiceRequest(request));
    client.on('voice-audio', (audio) => this.onVoiceAudio(audio));
    client.on('announce-finished', ({ success }) => this.playbackWaiter?.(success));
    client.on('disconnected', () => this.onDisconnected());
  }

  // -------------------------------------------------------------------------
  // Messages from the Echo
  // -------------------------------------------------------------------------

  private onVoiceRequest(request: VoiceAssistantRequest): void {
    if (!request.start) {
      this.onEchoAbort();
      return;
    }
    const current = this.turn;
    if (current && !current.finished) {
      if (current.handedOver) {
        // A new run means playback is over (a follow-up) or was cut by the wake word.
        this.playbackWaiter?.(true);
      } else {
        // The wake word / button again while we were busy: the new run wins.
        log.info('new run while busy, dropping the current turn');
        current.silenced = true;
        current.abort.abort(new Error('superseded by a new request'));
      }
    }
    this.startVoiceTurn(request);
  }

  private onEchoAbort(): void {
    const turn = this.turn;
    if (!turn || turn.finished) return; // e.g. stop() after our own ERROR: already over
    log.info('the Echo aborted the run');
    turn.silenced = true;
    if (turn.handedOver) {
      this.playbackWaiter?.(false);
      return;
    }
    turn.abort.abort(new Error('aborted on the Echo'));
    // While listening nothing async runs that would notice the abort.
    if (turn.phase === 'listening') this.finish(turn, 'aborted', 'aborted on the Echo');
  }

  private onDisconnected(): void {
    const turn = this.turn;
    if (turn && !turn.finished) {
      log.warn('echo disconnected mid-turn, aborting it');
      turn.silenced = true;
      turn.abort.abort(new Error('echo disconnected'));
      if (turn.phase === 'listening') this.finish(turn, 'aborted', 'echo disconnected');
    }
    this.playbackWaiter?.(false);
  }

  private startVoiceTurn(request: VoiceAssistantRequest): void {
    const { client } = this.options;
    const snapshot = this.options.settings();
    const settings = snapshot.settings;
    const followUp = Date.now() < this.followUpUntilMs;
    const vadOptions: Omit<VadOptions, 'sampleRate'> = followUp
      ? followUpVad(settings.vad, this.followUpWaitMs)
      : settings.vad;
    this.followUpUntilMs = 0;
    this.followUpWaitMs = null;
    log.info(followUp ? 'follow-up turn started' : 'turn started', {
      wakeWord: request.wakeWordPhrase || undefined,
      flags: request.flags,
      settingsVersion: snapshot.version,
      vad: {
        noSpeechTimeoutMs: vadOptions.noSpeechTimeoutMs,
        endSilenceMs: vadOptions.endSilenceMs,
        maxUtteranceMs: vadOptions.maxUtteranceMs,
        startGuardMs: vadOptions.startGuardMs,
      },
    });

    const turn: ActiveTurn = {
      ...this.newTurn('voice', snapshot, this.sessionKey()),
      followUp,
      vad: new EndOfSpeechDetector({ sampleRate: MIC_RATE, ...vadOptions }),
      audio: [],
      eager: null,
      deadline: null,
      deadlineAtMs: null,
    };
    // The user is about to speak for a few seconds: time to open the connection.
    this.options.services.warmUp?.();
    turn.deadline = setTimeout(() => {
      log.warn('listening took too long (the mic stream stalled?)');
      this.endListening(turn, turn.vad?.speechHeard ? 'speech' : 'no-speech', 'wall-clock-listen-deadline');
    }, vadOptions.maxUtteranceMs + LISTEN_GRACE_MS);
    turn.deadline.unref();
    this.turn = turn;
    this.state = 'listening';

    // port 0: the mic audio comes over this connection (API_AUDIO).
    client.sendVoiceResponse({ port: 0 });
    this.event(turn, VA_EVENT.RUN_START);
    // STT_START puts the Echo into "listening"; it must come before STT_VAD_END,
    // never after it (hassmic would listen again with the mic closed).
    this.event(turn, VA_EVENT.STT_START);
  }

  private onVoiceAudio(audio: VoiceAssistantAudio): void {
    const turn = this.turn;
    if (!turn || turn.finished || turn.phase !== 'listening' || !turn.vad) return;
    if (audio.end) {
      // This distinguishes the Echo closing its stream from our VAD reaching its timeout.
      log.info('Echo ended microphone audio', {
        elapsedMs: this.elapsed(turn),
        audioMs: turn.vad.audioMs,
        dataBytes: audio.data.length,
        followUp: turn.followUp,
        speechHeard: turn.vad.speechHeard,
        silenceMs: turn.vad.silenceMs,
        speechEndAtMs: turn.vad.speechEndAtMs,
        noiseFloorDb: turn.vad.noiseFloor,
      });
    }
    if (audio.data.length > 0) {
      turn.audio.push(audio.data);
      const decision = turn.vad.push(audio.data);
      if (decision === 'no-speech') {
        // The opening check may still be transcribing an answer from the
        // guard window: its result decides, not the clock.
        if (turn.openingChecking) {
          turn.pendingNoSpeech = true;
          return;
        }
        this.endListening(turn, 'no-speech', 'vad-no-speech-timeout');
        return;
      }
      if (decision === 'speech-ended') {
        // Home Assistant's VAD does this job for hassmic; here it is ours.
        this.endListening(turn, 'speech', 'vad-silence-after-speech');
        return;
      }
      if (decision === 'max-length') {
        this.endListening(turn, 'speech', 'vad-max-utterance');
        return;
      }
      this.transcribeEarly(turn);
      // The VAD is deaf inside the start guard; STT covers that window.
      this.checkOpening(turn);
    }
    if (audio.end) {
      // The Echo heard the end of the request itself (micend, setting end_of_request).
      this.endListening(turn, turn.vad.speechHeard ? 'speech' : 'no-speech', 'echo-audio-end');
    }
  }

  // -------------------------------------------------------------------------
  // The voice turn
  // -------------------------------------------------------------------------

  private endListening(
    turn: ActiveTurn,
    heard: 'speech' | 'no-speech',
    reason:
      | 'wall-clock-listen-deadline'
      | 'vad-no-speech-timeout'
      | 'vad-silence-after-speech'
      | 'vad-max-utterance'
      | 'vad-wake-sound-check'
      | 'echo-audio-end',
  ): void {
    if (turn.finished || turn.phase !== 'listening') return;
    const vad = turn.vad;
    log.info('ending microphone capture', {
      reason,
      heard,
      elapsedMs: this.elapsed(turn),
      audioMs: vad?.audioMs,
      followUp: turn.followUp,
      speechHeard: vad?.speechHeard,
      silenceMs: vad?.silenceMs,
      speechEndAtMs: vad?.speechEndAtMs,
      lastLoudAtMs: vad?.lastLoudAtMs,
      noiseFloorDb: vad?.noiseFloor,
    });
    turn.phase = 'thinking';
    this.state = 'thinking';
    turn.timings.speechEndMs = this.elapsed(turn);
    // From here the reply has the turn deadline to reach the Echo.
    if (turn.deadline) clearTimeout(turn.deadline);
    const { turnDeadlineMs } = turn.settings.pipeline;
    turn.deadlineAtMs = Date.now() + turnDeadlineMs;
    turn.deadline = setTimeout(() => this.onDeadline(turn), turnDeadlineMs);
    turn.deadline.unref();
    // Mic off, ring to "thinking".
    this.event(turn, VA_EVENT.STT_VAD_END);
    void this.runVoiceTurn(turn, heard);
  }

  /**
   * Starts transcribing during the pause that may turn out to be the end of
   * the utterance. When it is the end, the answer is already on its way; when
   * the user goes on speaking, the result is ignored. A request that is no
   * longer needed is left to finish: aborting it would close its connection,
   * and the next request would have to open a new one.
   */
  private transcribeEarly(turn: ActiveTurn): void {
    const { eagerSilenceMs } = turn.settings.stt;
    const vad = turn.vad;
    if (eagerSilenceMs <= 0 || !vad?.speechHeard || vad.silenceMs < eagerSilenceMs) return;
    if (turn.eager?.speechEndAtMs === vad.speechEndAtMs) return;
    turn.eager = {
      speechEndAtMs: vad.speechEndAtMs,
      result: this.options.services.stt
        .transcribe(this.trimmedAudio(turn), MIC_RATE, turn.abort.signal, turn.settings)
        .then(
          (text) => ({ text }),
          (error: unknown) => ({ error }),
        ),
    };
  }

  /**
   * A follow-up starts with a 2 s VAD guard (the Echo's wake sound lives
   * there). The guard is intentionally deaf, but the audio is kept: if it held
   * something louder than the Echo's own sound and has gone quiet, transcribe
   * that opening and use it. That covers an answer given inside the guard
   * without letting the sound itself end the turn — the transcript decides.
   */
  private checkOpening(turn: ActiveTurn): void {
    const vad = turn.vad;
    if (!vad || !turn.followUp || turn.openingChecked || vad.speechHeard) return;
    if (vad.liveStart === null) return;
    // Only the Echo's own sound so far: nothing of the user's to transcribe.
    if (vad.lastLoudAtMs <= vad.liveStart + WAKE_SOUND_TAIL_MS) return;
    // Still in the guard, or the sound is still going on.
    if (vad.audioMs < vad.guardEndMs) return;
    if (vad.audioMs - vad.lastLoudAtMs < turn.settings.vad.endSilenceMs) return;
    turn.openingChecked = true;
    turn.openingChecking = true;
    const pcm = this.audioUpTo(turn, vad.lastLoudAtMs + SPEECH_TAIL_MS);
    log.info('follow-up: checking the opening audio (the VAD is deaf for the wake sound)', {
      audioMs: vad.audioMs,
      lastLoudAtMs: vad.lastLoudAtMs,
      guardEndMs: vad.guardEndMs,
    });
    const finish = (text: string | null): void => {
      turn.openingChecking = false;
      if (turn.finished || turn.phase !== 'listening') return;
      if (text !== null && isUsableTranscript(text)) {
        log.info(`heard in the follow-up's opening: "${text}"`);
        turn.forcedText = text;
        this.endListening(turn, 'speech', 'vad-wake-sound-check');
        return;
      }
      log.info('follow-up: the opening held only the Echo’s own sound');
      // The wait ran out while the check was still going: end it now.
      if (turn.pendingNoSpeech) this.endListening(turn, 'no-speech', 'vad-no-speech-timeout');
    };
    void this.options.services.stt
      .transcribe(pcm, MIC_RATE, turn.abort.signal, turn.settings)
      .then(finish, (error: unknown) => {
        if (!turn.finished && turn.phase === 'listening')
          log.warn(`follow-up opening check failed: ${errorMessage(error)}`);
        finish(null);
      });
  }

  /** The text of the utterance: from the opening check or the early transcription when either heard it all, else a new one. */
  private async transcribe(turn: ActiveTurn, pcm: Buffer): Promise<string> {
    const signal = turn.abort.signal;
    if (turn.forcedText !== undefined) return turn.forcedText;
    const eager = turn.eager;
    if (eager && eager.speechEndAtMs === turn.vad?.speechEndAtMs) {
      const result = await eager.result;
      signal.throwIfAborted();
      if ('text' in result) return result.text;
      log.warn(`early transcription failed, trying again: ${errorMessage(result.error)}`);
    }
    return this.options.services.stt.transcribe(pcm, MIC_RATE, signal, turn.settings);
  }

  /**
   * Watches the answer while the agent writes it and starts TTS on its first
   * sentence. The audio is not handed to the Echo before the whole answer is
   * known: INTENT_END (follow-up or not) must go out first, and text written
   * before a tool call is not the answer.
   */
  private earlyReply(turn: ActiveTurn) {
    const { services } = this.options;
    const discard = new AbortController();
    const signal = AbortSignal.any([turn.abort.signal, discard.signal]);
    let started: { head: string; audio: ReplyAudio; giveRest: (rest: string) => void } | null = null;
    const cancel = () => {
      if (!started) return;
      discard.abort(new Error('reply discarded'));
      started.giveRest('');
      this.releaseReply(started.audio);
      started = null;
    };
    return {
      onText: (textSoFar: string) => {
        if (started) return;
        const head = firstSentence(textSoFar);
        if (!head) return;
        let giveRest: (rest: string) => void = () => {};
        const rest = new Promise<string>((resolve) => {
          giveRest = resolve;
        });
        started = {
          head,
          giveRest,
          audio: this.startReply(
            headThenRest(services.tts, head, rest, signal, turn.settings),
            turn.settings,
          ),
        };
      },
      /** The audio already on its way for the answer `text`, or null (none, or it was for other text). */
      take: (text: string): ReplyAudio | null => {
        if (!started) return null;
        if (!text.startsWith(started.head)) {
          cancel();
          return null;
        }
        started.giveRest(text.slice(started.head.length).trim());
        return started.audio;
      },
      cancel,
    };
  }

  private async runVoiceTurn(turn: ActiveTurn, heard: 'speech' | 'no-speech'): Promise<void> {
    const { services } = this.options;
    const signal = turn.abort.signal;
    const early = this.earlyReply(turn);
    try {
      // Diagnostic for the wake-sound guard: keep the whole follow-up audio,
      // including the 800 ms lead-in and the Echo's own sound, even when
      // nothing was recognised. A no-op unless DEBUG_AUDIO_DIR is set.
      if (turn.followUp) this.saveDebugWav(Buffer.concat(turn.audio));
      if (heard === 'no-speech') {
        this.endQuietly(turn);
        return;
      }

      // Trailing silence is cut off: less to upload, same text.
      const pcm = this.trimmedAudio(turn);
      this.saveDebugWav(pcm);

      const text = await this.transcribe(turn, pcm);
      signal.throwIfAborted();
      turn.timings.transcriptMs = this.elapsed(turn);
      if (!isUsableTranscript(text)) {
        log.info('nothing usable recognised', { text });
        turn.transcript = text || null;
        this.endQuietly(turn);
        return;
      }
      turn.transcript = text;
      log.info(`heard: "${text}"`);
      this.event(turn, VA_EVENT.STT_END, { text });
      this.event(turn, VA_EVENT.INTENT_START);

      const session = this.options.sessions.get(
        turn.sessionKey,
        turn.settings.assistant.sessionIdleMinutes * 60_000,
      );
      const reply = await services.agent.reply(text, signal, early.onText, {
        settings: turn.settings,
        session,
        device: this.options.device(),
        toolSet: turn.toolSet,
        deviceId: this.options.deviceId,
        deadlineAtMs: turn.deadlineAtMs,
      });
      signal.throwIfAborted();
      turn.timings.agentDoneMs = this.elapsed(turn);
      turn.toolCalls = reply.toolCalls;
      turn.displayText = reply.displayText;
      turn.citations = reply.citations;
      turn.reply = reply.text || turn.settings.assistant.apologyText;
      const { mode, questionMarkFallback } = turn.settings.followUp;
      const listenMs = expectsAnswer(turn.reply, mode, {
        listen: reply.listen !== undefined,
        questionMarkFallback,
      })
        ? (reply.listen?.waitMs ?? turn.settings.vad.noSpeechTimeoutMs)
        : null;
      log.info(
        `reply: "${turn.reply}"${listenMs !== null ? ` (listening ${listenMs} ms for an answer)` : ''}`,
      );

      const played = await this.speak(turn, turn.reply, listenMs, early.take(turn.reply));
      this.finish(turn, turn.silenced && !played ? 'aborted' : 'answered');
    } catch (error) {
      early.cancel();
      await this.failTurn(turn, error);
    }
  }

  /** Nothing usable was said: this exact code ends the run on the Echo without the error sound. */
  private endQuietly(turn: ActiveTurn): void {
    turn.timings.transcriptMs ??= this.elapsed(turn);
    this.event(turn, VA_EVENT.ERROR, { code: 'stt-no-text-recognized', message: 'No speech recognised' });
    this.event(turn, VA_EVENT.RUN_END);
    turn.handedOver = true;
    this.finish(turn, 'no-speech');
  }

  /** Nothing has been handed to the Echo by now: give up, say sorry. */
  private onDeadline(turn: ActiveTurn): void {
    if (turn.finished || turn.handedOver) return;
    const { turnDeadlineMs } = turn.settings.pipeline;
    log.warn(`no reply ${turnDeadlineMs} ms after the end of speech`);
    turn.abort.abort(new Error(`no answer within ${turnDeadlineMs} ms`));
  }

  private async failTurn(turn: ActiveTurn, error: unknown): Promise<void> {
    if (turn.finished) return;
    const { client } = this.options;
    const reason = signalReason(turn.abort.signal) ?? errorMessage(error);

    if (turn.silenced || !client.isConnected) {
      log.info(`turn dropped: ${reason}`);
      this.finish(turn, 'aborted', reason);
      return;
    }
    log.error(`turn failed: ${reason}`);
    if (turn.handedOver) {
      // The reply was already on its way (TTS broke mid-stream): the Echo plays what it got.
      this.finish(turn, 'error', reason);
      return;
    }

    // Try a short spoken apology (fresh signal, tight budget); if even that
    // fails, ERROR makes the Echo play its error sound and end the run.
    const apology = new AbortController();
    // The budget covers getting the apology to the Echo, not its playback.
    const budget = setTimeout(() => {
      if (!turn.handedOver) apology.abort(new Error('apology timed out'));
    }, 5000);
    try {
      turn.abort = apology;
      await this.speak(turn, turn.settings.assistant.apologyText, null);
    } catch (apologyError) {
      log.warn(`apology failed: ${errorMessage(apologyError)}`);
      if (!turn.handedOver) {
        this.event(turn, VA_EVENT.ERROR, { code: 'pipeline-error', message: reason.slice(0, 200) });
        this.event(turn, VA_EVENT.RUN_END);
        turn.handedOver = true;
      }
    } finally {
      clearTimeout(budget);
    }
    this.finish(turn, 'error', reason);
  }

  // -------------------------------------------------------------------------
  // Speaking (answers, apologies) and announcements
  // -------------------------------------------------------------------------

  /**
   * Starts TTS (unless `prepared` is the reply's audio, started while the
   * agent was still writing), waits for its first audio (so a TTS failure can still be
   * answered with an apology or ERROR), hands the URL to the Echo with
   * TTS_END + RUN_END and waits until it has played it. Returns whether the
   * Echo reported playback done.
   */
  private async speak(
    turn: ActiveTurn,
    text: string,
    /** Listen for an answer after this reply, waiting this long for speech; null = no follow-up. */
    listenMs: number | null,
    prepared: ReplyAudio | null = null,
  ): Promise<boolean> {
    const { services } = this.options;
    turn.phase = 'speaking';
    this.state = 'speaking';
    const reply =
      prepared ??
      this.startReply(services.tts.synthesize(text, turn.abort.signal, turn.settings), turn.settings);
    try {
      await reply.ready(turn.settings.reply.prebufferMs);
      turn.abort.signal.throwIfAborted();
      turn.timings.firstAudioMs = this.elapsed(turn);
      // INTENT_END only now: with continue_conversation hassmic listens again
      // after the next playback, so it must not go out before a reply that plays.
      this.event(turn, VA_EVENT.INTENT_END, { continue_conversation: listenMs !== null ? '1' : '0' });
      this.event(turn, VA_EVENT.TTS_START, { text });
      this.event(turn, VA_EVENT.TTS_END, { url: this.replyUrl(reply) });
      this.event(turn, VA_EVENT.RUN_END);
      turn.handedOver = true;
      // The follow-up run arrives right after AnnounceFinished, before this
      // turn has finished: arm the flag now, it is consumed by that run.
      if (listenMs !== null) {
        this.followUpUntilMs = Number.POSITIVE_INFINITY;
        this.followUpWaitMs = listenMs;
      }
      const played = await this.waitForPlayback(turn, reply);
      if (this.followUpUntilMs === Number.POSITIVE_INFINITY) {
        this.followUpUntilMs = played ? Date.now() + FOLLOW_UP_WINDOW_MS : 0;
      }
      if (played) turn.timings.playedMs = this.elapsed(turn);
      turn.timings.audioDoneMs = turn.timings.playedMs;
      return played;
    } finally {
      this.releaseReply(reply);
    }
  }

  /** Serves TTS audio (`stream`, at the TTS service's sample rate) as this device's current reply. */
  private startReply(stream: AsyncIterable<Buffer>, settings: Settings): ReplyAudio {
    const { services, replies } = this.options;
    const sourceRate = services.tts.sampleRate;
    const rate = settings.tts.outputRate > 0 ? settings.tts.outputRate : sourceRate;
    // One current reply per device: the previous one stops being served now.
    this.revokeCurrentReply();
    let reply: ReplyAudio;
    if (rate === sourceRate) {
      reply = replies.create(stream, rate);
    } else {
      const resampler = new LinearResampler(sourceRate, rate);
      reply = replies.create(
        mapStream(stream, (chunk) => resampler.push(chunk)),
        rate,
      );
    }
    this.currentReply = reply;
    return reply;
  }

  /** The reply this device is serving, if any (for the manager's revoke on delete). */
  get replyId(): string | null {
    return this.currentReply?.id ?? null;
  }

  private revokeCurrentReply(): void {
    const reply = this.currentReply;
    if (!reply) return;
    this.currentReply = null;
    this.options.replies.revoke(reply);
  }

  /** Stops serving one reply and forgets it if it is still this device's current one. */
  private releaseReply(reply: ReplyAudio): void {
    if (this.currentReply === reply) this.currentReply = null;
    this.options.replies.revoke(reply);
  }

  /** `device:<id>` for an Echo, `web` for /api/ask without one. */
  private sessionKey(): string {
    return this.options.deviceId === null ? 'web' : `device:${this.options.deviceId}`;
  }

  private replyUrl(reply: ReplyAudio): string {
    const base = this.options.config.reply.baseUrl || this.options.fallbackReplyBaseUrl?.() || '';
    return `${base}/api/reply-audio/${reply.id}.wav`;
  }

  /**
   * Waits for VoiceAssistantAnnounceFinished. The audio downloads faster than
   * it plays, so the timeout is its length (once known) plus a grace period.
   * Resolves true when the Echo reported it played, false otherwise.
   */
  private waitForPlayback(turn: ActiveTurn, reply: ReplyAudio): Promise<boolean> {
    const { playedGraceMs } = turn.settings.echo;
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (success: boolean) => {
        if (this.playbackWaiter === done) this.playbackWaiter = null;
        clearTimeout(timer);
        turn.abort.signal.removeEventListener('abort', onAbort);
        resolve(success);
      };
      const onAbort = () => done(false);
      this.playbackWaiter = done;
      turn.abort.signal.addEventListener('abort', onAbort, { once: true });
      void reply.finished().then(() => {
        if (this.playbackWaiter !== done) return;
        const startedAt = reply.firstFetchAtMs ?? Date.now();
        const waitMs = Math.max(0, reply.durationMs - (Date.now() - startedAt)) + playedGraceMs;
        timer = setTimeout(() => {
          log.warn(`no playback report from the Echo within ${waitMs} ms`);
          done(false);
        }, waitMs);
        timer.unref();
      });
    });
  }

  /**
   * POST /api/say: speak text on the Echo between turns, as an announcement
   * (VoiceAssistantAnnounceRequest with the URL of the audio). The optional
   * preview overrides the voice for this call only, without saving anything.
   */
  async say(text: string, preview?: VoicePreview): Promise<Turn> {
    const { client } = this.options;
    if (!client.isConnected) throw new EchoUnavailableError('ECHO_UNAVAILABLE', 'The Echo is not connected.');
    if (this.state !== 'idle')
      throw new EchoUnavailableError('ECHO_BUSY', 'The Echo is busy with a request.');

    const snapshot = this.options.settings();
    const withPreview: SettingsSnapshot = preview
      ? { version: snapshot.version, settings: withVoicePreview(snapshot.settings, preview) }
      : snapshot;
    const turn: ActiveTurn = {
      ...this.newTurn('say', withPreview, this.sessionKey()),
      followUp: false,
      vad: null,
      audio: [],
      eager: null,
      deadline: null,
      deadlineAtMs: null,
    };
    turn.phase = 'speaking';
    turn.reply = text;
    this.turn = turn;
    this.state = 'announcing';
    const reply = this.startReply(
      this.options.services.tts.synthesize(text, turn.abort.signal, turn.settings),
      turn.settings,
    );
    try {
      await reply.ready(turn.settings.reply.prebufferMs);
      turn.timings.firstAudioMs = this.elapsed(turn);
      if (!client.sendAnnounce({ mediaId: this.replyUrl(reply), text, startConversation: false })) {
        throw new EchoUnavailableError('ECHO_UNAVAILABLE', 'The Echo is not connected.');
      }
      turn.handedOver = true;
      const played = await this.waitForPlayback(turn, reply);
      if (turn.finished) return this.lastTurn ?? this.record(turn, 'aborted');
      if (played) {
        turn.timings.playedMs = this.elapsed(turn);
        turn.timings.audioDoneMs = turn.timings.playedMs;
        return this.finish(turn, 'answered');
      }
      if (turn.silenced || !client.isConnected) {
        this.finish(turn, 'aborted', 'the Echo did not finish the announcement');
        throw new EchoUnavailableError('ECHO_UNAVAILABLE', 'The Echo disconnected during the announcement.');
      }
      this.finish(turn, 'error', 'the Echo did not play the announcement');
      throw new EchoUnavailableError(
        'ECHO_BUSY',
        'The Echo did not play the announcement (busy, do not disturb, or no answer).',
      );
    } catch (error) {
      if (!turn.finished) {
        const reason = signalReason(turn.abort.signal) ?? errorMessage(error);
        this.finish(turn, turn.abort.signal.aborted ? 'aborted' : 'error', reason);
      }
      throw error;
    } finally {
      this.releaseReply(reply);
    }
  }

  /**
   * POST /api/ask: run the agent on text, without the Echo. With a device it
   * uses that Echo's settings, prompt and memory; without, `web` and the
   * global settings.
   */
  async ask(text: string): Promise<Turn> {
    const snapshot = this.options.settings();
    const turn: ActiveTurn = {
      ...this.newTurn('ask', snapshot, this.sessionKey()),
      followUp: false,
      vad: null,
      audio: [],
      eager: null,
      deadline: null,
      deadlineAtMs: null,
    };
    turn.transcript = text;
    try {
      const session = this.options.sessions.get(
        turn.sessionKey,
        turn.settings.assistant.sessionIdleMinutes * 60_000,
      );
      const reply = await this.options.services.agent.reply(text, turn.abort.signal, undefined, {
        settings: turn.settings,
        session,
        device: this.options.device(),
        toolSet: turn.toolSet,
        deviceId: this.options.deviceId,
        deadlineAtMs: null,
      });
      turn.timings.agentDoneMs = this.elapsed(turn);
      turn.displayText = reply.displayText;
      turn.citations = reply.citations;
      turn.reply = reply.text;
      turn.toolCalls = reply.toolCalls;
      return this.record(turn, 'answered');
    } catch (error) {
      this.record(turn, 'error', errorMessage(error));
      throw error;
    }
  }

  /**
   * Stops this runtime: aborts a running turn (the onDisconnected path),
   * drops the follow-up window and revokes the device's current reply. The
   * client's socket is closed by the manager right after.
   */
  stop(): void {
    const turn = this.turn;
    if (turn && !turn.finished) {
      turn.silenced = true;
      turn.abort.abort(new Error('device stopped'));
      if (turn.phase === 'listening') this.finish(turn, 'aborted', 'device stopped');
    }
    this.playbackWaiter?.(false);
    this.followUpUntilMs = 0;
    this.followUpWaitMs = null;
    this.revokeCurrentReply();
    this.state = 'idle';
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Sends a pipeline event for `turn`, unless the Echo has dropped that run. */
  private event(
    turn: ActiveTurn,
    type: (typeof VA_EVENT)[keyof typeof VA_EVENT],
    data?: Record<string, string>,
  ) {
    if (turn.silenced || turn !== this.turn) return;
    this.options.client.sendEvent(type, data);
  }

  private newTurn(
    source: TurnSource,
    snapshot: SettingsSnapshot,
    sessionKey: string,
  ): Omit<ActiveTurn, 'vad' | 'audio' | 'eager' | 'deadline' | 'deadlineAtMs' | 'followUp'> {
    return {
      source,
      startedAt: new Date(),
      startedAtMs: Date.now(),
      abort: new AbortController(),
      timings: {},
      transcript: null,
      reply: null,
      toolCalls: [],
      phase: 'listening',
      finished: false,
      handedOver: false,
      silenced: false,
      settings: snapshot.settings,
      settingsVersion: snapshot.version,
      toolSet: this.options.tools.snapshot({ settings: snapshot.settings, deviceId: this.options.deviceId }),
      sessionKey,
    };
  }

  private elapsed(turn: ActiveTurn): number {
    return Date.now() - turn.startedAtMs;
  }

  private finish(turn: ActiveTurn, outcome: TurnOutcome, error?: string): Turn {
    turn.finished = true;
    if (turn.deadline) clearTimeout(turn.deadline);
    if (this.turn === turn) {
      this.turn = null;
      this.state = 'idle';
    }
    const t = turn.timings;
    log.info(`turn ${outcome}${turn.followUp ? ' (follow-up)' : ''}`, {
      source: turn.source,
      speechEnd: t.speechEndMs,
      transcript: t.transcriptMs,
      agent: t.agentDoneMs,
      firstAudio: t.firstAudioMs,
      played: t.playedMs,
    });
    return this.record(turn, outcome, error);
  }

  private record(turn: ActiveTurn, outcome: TurnOutcome, error?: string): Turn {
    try {
      const saved = this.options.turns.insert({
        source: turn.source,
        outcome,
        startedAt: turn.startedAt,
        deviceId: this.options.deviceId,
        settingsVersion: turn.settingsVersion,
        transcript: turn.transcript,
        reply: turn.reply,
        displayText: turn.displayText,
        citations: turn.citations,
        toolCalls: turn.toolCalls,
        timings: turn.timings,
        error: error ?? null,
      });
      this.lastTurn = saved;
      return saved;
    } catch (dbError) {
      // Losing a history row must never break the conversation.
      log.error(`could not save turn: ${errorMessage(dbError)}`);
      return {
        id: 0,
        source: turn.source,
        outcome,
        startedAt: turn.startedAt.toISOString(),
        deviceId: this.options.deviceId,
        deviceName: this.options.device()?.name ?? null,
        settingsVersion: turn.settingsVersion,
        transcript: turn.transcript,
        reply: turn.reply,
        displayText: turn.displayText,
        citations: turn.citations,
        toolCalls: turn.toolCalls,
        timings: turn.timings,
        error: error ?? null,
      };
    }
  }

  private trimmedAudio(turn: ActiveTurn): Buffer {
    const all = Buffer.concat(turn.audio);
    if (!turn.vad?.speechHeard) return all;
    const endMs = Math.min(turn.vad.speechEndAtMs + SPEECH_TAIL_MS, pcmDurationMs(all.length, MIC_RATE));
    const endByte = Math.floor((endMs / 1000) * MIC_RATE) * 2;
    return all.subarray(0, endByte);
  }

  /** The captured audio up to an audio position (the opening check's slice). */
  private audioUpTo(turn: ActiveTurn, endMs: number): Buffer {
    const all = Buffer.concat(turn.audio);
    const endByte = Math.min(Math.floor((endMs / 1000) * MIC_RATE) * 2, all.length);
    return all.subarray(0, endByte);
  }

  /** DEBUG_AUDIO_DIR: one WAV per utterance, newest DEBUG_AUDIO_KEEP kept. */
  private saveDebugWav(pcm: Buffer): void {
    const { audioDir, audioKeep } = this.options.config.debug;
    if (!audioDir) return;
    try {
      mkdirSync(audioDir, { recursive: true });
      const file = path.join(audioDir, `utterance-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
      writeFileSync(file, pcmToWav(pcm, MIC_RATE));
      const wavs = readdirSync(audioDir)
        .filter((name) => name.startsWith('utterance-') && name.endsWith('.wav'))
        .sort();
      for (const old of wavs.slice(0, Math.max(0, wavs.length - audioKeep))) {
        rmSync(path.join(audioDir, old), { force: true });
      }
    } catch (error) {
      log.warn(`could not write debug audio: ${errorMessage(error)}`);
    }
  }
}

export type FollowUpMode = 'tool' | 'question' | 'always' | 'never';

/**
 * FOLLOW_UP_MODE: should the Echo listen again after this answer, without the
 * wake word? `tool` = when the model called listen_for_reply (`listen`), plus
 * a trailing question mark if `questionMarkFallback` is on; `question` = only
 * the trailing question mark (the old heuristic).
 */
export function expectsAnswer(
  reply: string,
  mode: FollowUpMode,
  { listen = false, questionMarkFallback = false }: { listen?: boolean; questionMarkFallback?: boolean } = {},
): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (mode === 'tool') return listen || (questionMarkFallback && endsWithQuestion(reply));
  return endsWithQuestion(reply);
}

function endsWithQuestion(reply: string): boolean {
  return /[?？¿]["'”’»)\]]*\s*$/u.test(reply.trim());
}

type ListenLimits = Pick<VadOptions, 'noSpeechTimeoutMs' | 'maxUtteranceMs'>;

/**
 * The VAD limits of a follow-up run: wait `waitMs` for the answer to start,
 * still give the answer its usual length within hassmic's own limit, and skip
 * the Echo's wake sound at the start (VadOptions.startGuardMs).
 */
export function followUpVad<T extends ListenLimits>(
  vad: T,
  waitMs: number | null,
): T & { startGuardMs: number } {
  const guarded = { ...vad, startGuardMs: FOLLOW_UP_START_GUARD_MS };
  if (waitMs === null) return guarded;
  const noSpeechTimeoutMs = Math.min(waitMs, FOLLOW_UP_LISTEN_LIMIT_MS);
  const maxUtteranceMs = Math.max(
    vad.maxUtteranceMs,
    Math.min(noSpeechTimeoutMs + vad.maxUtteranceMs, FOLLOW_UP_LISTEN_LIMIT_MS),
  );
  return { ...guarded, noSpeechTimeoutMs, maxUtteranceMs };
}

/** The turn's settings with the form's unsaved voice values, for the test phrase. */
function withVoicePreview(settings: Settings, preview: VoicePreview): Settings {
  const tts = { ...settings.tts };
  if (preview.voice !== undefined) tts.voice = preview.voice;
  if (preview.speed !== undefined) tts.speed = preview.speed;
  if (preview.instructions !== undefined) tts.instructions = preview.instructions;
  return { ...settings, tts };
}

/** Whisper-style models return things like "." or "you" for silence. */
function isUsableTranscript(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function signalReason(signal: AbortSignal): string | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

async function* mapStream(
  source: AsyncIterable<Buffer>,
  map: (chunk: Buffer) => Buffer,
): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    const mapped = map(chunk);
    if (mapped.length > 0) yield mapped;
  }
}
