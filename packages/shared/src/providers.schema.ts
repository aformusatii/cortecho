import { z } from 'zod';
import { voicePreviewSchema } from './voice.schema.ts';

// ---------------------------------------------------------------------------
// The provider contract for the Providers tab: ElevenLabs voice and model
// lists, the key checks, and the voice preview URL.
// ---------------------------------------------------------------------------

/** One voice of the owner's ElevenLabs account. */
export const elevenLabsVoiceSchema = z.object({
  /** The id `tts.elevenlabsVoiceId` stores. */
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  accent: z.string().optional(),
  gender: z.string().optional(),
  description: z.string().optional(),
  /** A sample the browser can play; proxied by GET /api/settings/elevenlabs-voices/:id/preview. */
  previewUrl: z.string().optional(),
});
export type ElevenLabsVoice = z.infer<typeof elevenLabsVoiceSchema>;

/**
 * Why a provider list is empty. `no-key` = no key stored; `missing-permission`
 * = the key works but is not scoped to read voices/models; `unavailable` =
 * the provider could not be reached or answered unusably.
 */
export const PROVIDER_LIST_REASONS = ['no-key', 'missing-permission', 'unavailable'] as const;
export type ProviderListReason = (typeof PROVIDER_LIST_REASONS)[number];

/**
 * Where a voice list came from. `account` is the keyed `/v2/voices` list;
 * `premade` is ElevenLabs' default voices, read without a key from `/v1/voices`
 * or from the built-in snapshot when that call cannot answer.
 */
export const ELEVENLABS_VOICE_SOURCES = ['account', 'premade'] as const;
export type ElevenLabsVoiceSource = (typeof ELEVENLABS_VOICE_SOURCES)[number];

export type ElevenLabsVoicesResponse = {
  voices: ElevenLabsVoice[];
  /**
   * Why the account list failed. Kept when `source` is `premade`, so the UI can
   * still explain the fallback instead of implying the key is missing.
   */
  reason?: ProviderListReason;
  source?: ElevenLabsVoiceSource;
};

/** One model of GET https://api.elevenlabs.io/v1/models. */
export const elevenLabsModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  canDoTextToSpeech: z.boolean(),
});
export type ElevenLabsModel = z.infer<typeof elevenLabsModelSchema>;

export type ElevenLabsModelsResponse = {
  models: ElevenLabsModel[];
  reason?: ProviderListReason;
};

/** POST /api/settings/check-<provider>: absent means "check the stored key". */
export const providerKeyCheckSchema = z.object({
  apiKey: z.string().trim().max(400).optional(),
});
export type ProviderKeyCheck = z.infer<typeof providerKeyCheckSchema>;

/**
 * `rejected`  the provider answered and refused the key (401/403).
 * `unreachable` no usable answer: network, timeout or a server error.
 */
export const PROVIDER_KEY_CHECK_CODES = ['rejected', 'unreachable'] as const;
export type ProviderKeyCheckCode = (typeof PROVIDER_KEY_CHECK_CODES)[number];
/**
 * `ok: true` means the key authenticated. A scoped key (ElevenLabs) can still
 * authenticate and lack `voices_read` / `models_read`; `missingPermissions`
 * then names what the optional lists need. Speech and transcription work.
 */
export type ProviderKeyCheckResult =
  | { ok: true; missingPermissions?: string[] }
  | { ok: false; code: ProviderKeyCheckCode };

/** POST /api/settings/voice-sample: the draft voice plus an optional phrase. */
export const DEFAULT_VOICE_SAMPLE_TEXT = 'Hi, this is how I will sound.';
export const voiceSampleRequestSchema = voicePreviewSchema.extend({
  text: z.string().trim().min(1).max(200).optional(),
});
export type VoiceSampleRequest = z.infer<typeof voiceSampleRequestSchema>;
