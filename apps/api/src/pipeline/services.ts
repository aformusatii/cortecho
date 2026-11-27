import { providerLabel, type Settings, type VoiceProvider } from '@cortecho/shared';
import type { CreateResponse } from './agent.ts';
import type { AgentSession } from './agent-sessions.ts';
import type { PromptDevice } from './prompt-layers.ts';

/**
 * The three AI steps of a turn, as interfaces. The OpenAI and ElevenLabs
 * implementations live in providers/; tests pass fakes, so the pipeline and the
 * fake-Echo tests run without network access or an API key.
 *
 * Every call takes the turn's settings snapshot: the models, the voice and
 * the timeouts are settings now, and a turn uses the values it started with.
 * The two audio stages dispatch on that snapshot, per call, so two Echos (or
 * two turns) can use different providers.
 */

/** Both providers stream raw 24 kHz, 16-bit signed LE, mono PCM. */
export const PCM_SAMPLE_RATE = 24_000;

export type SpeechToText = {
  /** Returns the recognised text ('' when nothing usable was said). */
  transcribe(pcm: Buffer, sampleRate: number, signal: AbortSignal, settings: Settings): Promise<string>;
};

export type AgentReply = import('@cortecho/shared').SearchDisplay & {
  text: string;
  toolCalls: import('@cortecho/shared').ToolCallRecord[];
  /**
   * The model called listen_for_reply: the Echo should listen again after
   * this reply, for the user to start answering within `waitMs`.
   */
  listen?: { waitMs: number };
};

export type AgentContext = {
  /** The turn's snapshot. */
  settings: Settings;
  /** This speaker's memory (AgentSessions). */
  session: AgentSession;
  /** The Echo the request comes from: its name and its owner-written prompt (layer 3). */
  device?: PromptDevice | null;
  /** The tool snapshot taken at the start of this turn (plugins + connectors). */
  toolSet?: import('../tools/registry.ts').ToolSet;
  /** The Echo's id, or null for the web speaker. */
  deviceId?: number | null;
  /** The turn deadline (voice) for clamping connector timeouts. */
  deadlineAtMs?: number | null;
};

export type Agent = {
  /**
   * Answers one user message, using and updating the conversation memory.
   * `onText` gets the text written so far, while the model is still writing.
   * Text written before a tool call is not part of the answer, so a caller
   * must compare what it saw with the final `text`.
   */
  reply(
    text: string,
    signal: AbortSignal,
    onText: ((textSoFar: string) => void) | undefined,
    context: AgentContext,
  ): Promise<AgentReply>;
  /** Forgets one conversation (the idle expiry is AgentSessions#get). */
  reset(session: AgentSession): void;
};

export type TextToSpeech = {
  /** Sample rate of the PCM that `synthesize` yields. */
  readonly sampleRate: number;
  synthesize(text: string, signal: AbortSignal, settings: Settings): AsyncIterable<Buffer>;
};

/** One provider's audio stages, as the dispatcher uses them. */
export type ProviderVoice = {
  transcribe: SpeechToText['transcribe'];
  readonly sampleRate: number;
  synthesize: TextToSpeech['synthesize'];
  configured(settings: Settings): boolean;
  warmUp(settings: Settings): void;
};

/** OpenAI also does thinking (the streamed Responses call). */
export type OpenAiVoice = ProviderVoice & { createResponse: CreateResponse };

export type ElevenLabsVoiceProvider = ProviderVoice;

export type VoiceServices = {
  stt: SpeechToText;
  agent: Agent;
  tts: TextToSpeech;
  /**
   * True when a snapshot has the keys its stages need (OpenAI for thinking, or
   * a selected audio provider). Takes the snapshot, never the global settings:
   * an Echo may select a provider the global configuration does not use.
   */
  isConfigured(settings: Settings): boolean;
  /**
   * Opens the connection to the AI services ahead of the first request of a
   * turn (called at the wake word). Never throws.
   */
  warmUp?: (settings: Settings) => void;
};

export class NotConfiguredError extends Error {
  readonly provider: VoiceProvider;
  constructor(provider: VoiceProvider) {
    super(`${providerLabel(provider)} is not configured (no API key in Settings → Providers).`);
    this.name = 'NotConfiguredError';
    this.provider = provider;
  }
}

/** The providers whose keys are missing for this snapshot, in a stable order. */
export function missingProviders(settings: Settings): VoiceProvider[] {
  const missing = new Set<VoiceProvider>();
  // Thinking is always OpenAI, so its key is always needed.
  if (!settings.openai.apiKey) missing.add('openai');
  if (!settings.elevenlabs.apiKey) {
    if (settings.stt.provider === 'elevenlabs') missing.add('elevenlabs');
    if (settings.tts.provider === 'elevenlabs') missing.add('elevenlabs');
  }
  return (['openai', 'elevenlabs'] as const).filter((provider) => missing.has(provider));
}
