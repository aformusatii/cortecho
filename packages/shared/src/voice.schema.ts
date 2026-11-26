import { z } from 'zod';
import type { DeviceStatus } from './device.schema.ts';
import { VOICE_PROVIDERS, type VoiceProvider } from './settings.registry.ts';

// ---------------------------------------------------------------------------
// The contract between the API and the status page: health, turns, and the
// two test endpoints (POST /api/say, POST /api/ask).
// ---------------------------------------------------------------------------

/** Longest text accepted by /api/say and /api/ask (OpenAI TTS takes up to 4096). */
export const MAX_TEXT_LENGTH = 1000;

const textField = z
  .string()
  .trim()
  .min(1, 'Enter some text.')
  .max(MAX_TEXT_LENGTH, `Use at most ${MAX_TEXT_LENGTH} characters.`);

const deviceIdField = z.number().int().positive();

/** The voice form's "play a test phrase": previews values without saving them. */
export const voicePreviewSchema = z.object({
  /** The draft provider; absent = the saved one. */
  provider: z.enum(VOICE_PROVIDERS).optional(),
  /** The OpenAI voice and model. */
  voice: z.string().min(1).max(50).optional(),
  model: z.string().min(1).max(100).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  instructions: z.string().max(1000).optional(),
  /** The ElevenLabs voice, model and stability. */
  elevenlabsVoiceId: z.string().min(1).max(100).optional(),
  elevenlabsModel: z.string().min(1).max(100).optional(),
  elevenlabsStability: z.number().min(0).max(1).optional(),
});
export type VoicePreview = z.infer<typeof voicePreviewSchema>;

export const sayRequestSchema = z
  .object({
    text: textField,
    deviceId: deviceIdField.optional(),
    /** Speak on every enabled `echo` device (the default when deviceId is absent). */
    all: z.literal(true).optional(),
    voice: voicePreviewSchema.optional(),
  })
  .refine((body) => !(body.deviceId !== undefined && body.all !== undefined), {
    message: 'Choose one Echo or all of them, not both.',
    path: ['deviceId'],
  });
export type SayRequest = z.infer<typeof sayRequestSchema>;

export const askRequestSchema = z.object({
  text: textField,
  /** That Echo's memory, prompt and settings; absent = `web` and the global settings. */
  deviceId: deviceIdField.optional(),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const turnsQuerySchema = z.object({
  limit: z.coerce.number<unknown>().int().min(1).max(100).default(20),
  deviceId: z.coerce.number<unknown>().int().min(1).optional(),
});
export type TurnsQuery = z.infer<typeof turnsQuerySchema>;

/** Where a turn came from: a spoken request, POST /api/ask, or POST /api/say. */
export const TURN_SOURCES = ['voice', 'ask', 'say'] as const;
export type TurnSource = (typeof TURN_SOURCES)[number];

/**
 * How a turn ended. `no-speech` = the user said nothing usable (the Echo ends
 * quietly); `error` = something failed (apology or the Echo's error sound);
 * `aborted` = the Echo cancelled the run or the link dropped.
 */
export const TURN_OUTCOMES = ['answered', 'no-speech', 'error', 'aborted'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export type ToolCallRecord = {
  name: string;
  arguments: string;
  /** What the tool returned (or the error message), truncated for display. */
  result: string;
  ok: boolean;
  durationMs: number;
  /** The connector slug for an MCP tool call (plugins have none). */
  server?: string;
  /** A “confirm by voice” call that asked for the user’s yes and did not run yet. */
  pending?: boolean;
  /** A failed call's stack trace (or the thrown value), for the status page. */
  errorDetail?: string;
};

/**
 * Milliseconds since the turn started (the Echo's VoiceAssistantRequest for
 * voice turns, the HTTP request otherwise). A missing value means the step did not happen.
 */
export type TurnTimings = {
  speechEndMs?: number;
  transcriptMs?: number;
  agentDoneMs?: number;
  firstAudioMs?: number;
  audioDoneMs?: number;
  playedMs?: number;
};

export type ReplyCitation = { start: number; end: number; url: string; title: string };
export type SearchDisplay = { displayText?: string; citations?: ReplyCitation[] };

export type Turn = SearchDisplay & {
  id: number;
  source: TurnSource;
  outcome: TurnOutcome;
  startedAt: string;
  /** The Echo the turn came from; null for old rows and /api/ask without a device. */
  deviceId: number | null;
  /** Joined at read time, so a rename shows on every turn. */
  deviceName: string | null;
  /** The settings version the turn ran with (null for rows from before versioning). */
  settingsVersion: number | null;
  transcript: string | null;
  reply: string | null;
  toolCalls: ToolCallRecord[];
  timings: TurnTimings;
  error: string | null;
};

export const ECHO_CONNECTION_STATES = ['disabled', 'connecting', 'connected', 'disconnected'] as const;
export type EchoConnectionState = (typeof ECHO_CONNECTION_STATES)[number];

/** What the pipeline is doing right now. */
export const PIPELINE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'announcing'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

/** Noise = the ESPHome API encryption with the Echo's key (needed for the clock); plaintext otherwise. */
export const ECHO_ENCRYPTIONS = ['noise', 'plaintext'] as const;
export type EchoEncryption = (typeof ECHO_ENCRYPTIONS)[number];

/** From the Echo's DeviceInfoResponse. */
export type EchoInfo = {
  name: string;
  friendlyName: string;
  model: string;
  /** hassmic's version (project_version). */
  version: string;
  /** VoiceAssistantFeature flags: announce, start conversation, … */
  supportsAnnounce: boolean;
  supportsFollowUp: boolean;
  /** The Echo has no key yet (DeviceInfoResponse.api_encryption_provisionable). */
  provisionable: boolean;
};

/**
 * Connection problems the owner has to fix (see README "Encryption").
 * `unexpected-device`: the address now reports another node name.
 * `duplicate-node-name`: two connected Echos report the same name, so hassmic's
 * arbitration cannot tell them apart.
 * `reply-address-missing`: production runs without `network.replyBaseUrl`, so
 * the Echo cannot download its answers.
 */
export const ECHO_PROBLEMS = [
  'encryption-required',
  'invalid-key',
  'key-not-set',
  'unexpected-device',
  'duplicate-node-name',
  'reply-address-missing',
] as const;
export type EchoProblem = (typeof ECHO_PROBLEMS)[number];

/** One AI stage as the status page shows it. */
export type HealthStage = {
  provider: VoiceProvider;
  /** The model (or voice) the stage uses. */
  model: string;
  /** The key this stage's provider needs is set. */
  configured: boolean;
};

export type Health = {
  status: 'ok';
  uptimeSeconds: number;
  /** One entry per known Echo; disabled ones show state 'disabled'. */
  devices: DeviceStatus[];
  openai: { configured: boolean; sttModel: string; agentModel: string; ttsModel: string };
  /** The provider each audio stage and thinking use right now. */
  providers: {
    stt: HealthStage;
    thinking: HealthStage & { provider: 'openai' };
    tts: HealthStage;
  };
  tools: string[];
  /** One entry per configured connector, for the status page. */
  connectors: import('./mcp.schema.ts').McpHealthEntry[];
  /** The settings version the current values came from (0 = no saved change yet). */
  settingsVersion: number;
  lastTurn: Turn | null;
};

export type AskResponse = {
  turn: Turn;
};

/** One Echo's attempt in a /api/say; a failure is reported, not thrown. */
export type SayResult = {
  deviceId: number;
  deviceName: string;
  ok: boolean;
  turn?: Turn;
  error?: { code: string; message: string };
};

export type SayResponse = {
  results: SayResult[];
};
