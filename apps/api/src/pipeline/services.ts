import type { Settings } from '@cortecho/shared';
import type { AgentSession } from './agent-sessions.ts';
import type { PromptDevice } from './prompt-layers.ts';

/**
 * The three AI steps of a turn, as interfaces. The OpenAI implementations
 * live in openai.ts; tests pass fakes, so the pipeline and the fake-Echo
 * tests run without network access or an API key.
 *
 * Every call takes the turn's settings snapshot: the models, the voice and
 * the timeouts are settings now, and a turn uses the values it started with.
 */

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

export type VoiceServices = {
  stt: SpeechToText;
  agent: Agent;
  tts: TextToSpeech;
  /** False when no OpenAI key is set; the pipeline then fails turns fast. */
  readonly configured: boolean;
  /**
   * Opens the connection to the AI service ahead of the first request of a
   * turn (called at the wake word). Never throws.
   */
  warmUp?: () => void;
};

export class NotConfiguredError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set');
    this.name = 'NotConfiguredError';
  }
}
