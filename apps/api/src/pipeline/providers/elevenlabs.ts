import type {
  ElevenLabsModelsResponse,
  ElevenLabsVoicesResponse,
  ProviderKeyCheckResult,
  ProviderListReason,
  Settings,
} from '@cortecho/shared';
import { pcmToWav } from '../audio.ts';
import { type ElevenLabsVoiceProvider, NotConfiguredError, PCM_SAMPLE_RATE } from '../services.ts';
import { ELEVENLABS_PREMADE_VOICES } from './elevenlabs-premade.ts';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
/** ElevenLabs' `speed` range for TTS voice settings. */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;

/**
 * The API host. `ELEVENLABS_BASE_URL` (environment-only, like OPENAI_BASE_URL)
 * lets a proxy sit in front; the key is still a setting and is never logged.
 */
export type ElevenLabsOptions = { baseUrl?: string };

/** Request options: the key is never logged or put in an error. */
type RequestOptions = ElevenLabsOptions & {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** The configured host without a trailing slash, or the default. */
function baseOf(baseUrl: string | undefined): string {
  return (baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '');
}

function endpoint(baseUrl: string | undefined, path: string): string {
  return `${baseOf(baseUrl)}${path}`;
}

function keyOf(settings: Settings): string {
  const key = settings.elevenlabs.apiKey;
  if (!key) throw new NotConfiguredError('elevenlabs');
  return key;
}

/** The abort signal for one request: the caller's signal plus the settings' timeout. */
function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** A scoped key authenticates but lacks the read permission for a list. */
function listFailureReason(status: number, detail: unknown): ProviderListReason {
  if (status === 401 || status === 403) {
    const body = detail as { detail?: { status?: unknown } } | null;
    if (body?.detail?.status === 'missing_permissions') return 'missing-permission';
  }
  return 'unavailable';
}

async function failureDetail(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function httpError(action: string, status: number): Error {
  const hint =
    status === 401 || status === 403 ? ' Check the ElevenLabs API key in Settings → Providers.' : '';
  return new Error(`ElevenLabs ${action} failed (HTTP ${status}).${hint}`);
}

function clampedSpeed(speed: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

type RawElevenLabsVoice = {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  preview_url?: unknown;
  labels?: Record<string, unknown>;
};

/** Map the `/v2/voices` and anonymous `/v1/voices` bodies the same way. */
function mapElevenLabsVoices(body: { voices?: RawElevenLabsVoice[] }): ElevenLabsVoicesResponse['voices'] {
  const label = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  return (body.voices ?? [])
    .filter((voice) => typeof voice.voice_id === 'string' && typeof voice.name === 'string')
    .map((voice) => ({
      id: voice.voice_id as string,
      name: voice.name as string,
      ...(label(voice.category) ? { category: label(voice.category) } : {}),
      ...(label(voice.labels?.accent) ? { accent: label(voice.labels?.accent) } : {}),
      ...(label(voice.labels?.gender) ? { gender: label(voice.labels?.gender) } : {}),
      ...((label(voice.description) ?? label(voice.labels?.description))
        ? { description: label(voice.description) ?? label(voice.labels?.description) }
        : {}),
      ...(label(voice.preview_url) ? { previewUrl: label(voice.preview_url) } : {}),
    }));
}

/** A voice list plus whether only the built-in snapshot answered. */
export type ElevenLabsVoicesResult = {
  response: ElevenLabsVoicesResponse;
  /** The service caches this briefly: the next request should retry the network. */
  fromSnapshot: boolean;
};

/**
 * ElevenLabs' default voices, which `/v1/voices` serves without a key. A scoped
 * key can speak but cannot read `/v2/voices`; this keeps the picker readable.
 * The request never carries the key, and the built-in snapshot is the offline
 * and broken-gateway last resort.
 */
async function premadeVoices({
  baseUrl,
  fetchImpl,
  signal,
  timeoutMs,
  reason,
}: {
  baseUrl: string | undefined;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
  reason?: ProviderListReason;
}): Promise<ElevenLabsVoicesResult> {
  try {
    const response = await fetchImpl(endpoint(baseUrl, '/v1/voices'), {
      headers: { Accept: 'application/json' },
      signal: requestSignal(signal, timeoutMs),
    });
    if (response.ok) {
      const voices = mapElevenLabsVoices((await response.json()) as { voices?: RawElevenLabsVoice[] });
      if (voices.length > 0) {
        return {
          response: { voices, ...(reason ? { reason } : {}), source: 'premade' },
          fromSnapshot: false,
        };
      }
    }
  } catch {
    // Fall through to the snapshot: the picker must still show names.
  }
  return {
    response: {
      voices: ELEVENLABS_PREMADE_VOICES.map((voice) => ({ ...voice })),
      ...(reason ? { reason } : {}),
      source: 'premade',
    },
    fromSnapshot: true,
  };
}

/**
 * The ElevenLabs account's voices, with the names and labels the picker shows.
 * A scoped key (or a provider that cannot answer) falls back to the default
 * voices; the original reason is kept so the UI can explain why. An empty
 * account list also falls back, because an empty picker is never useful.
 */
export async function listElevenLabsVoicesDetailed({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  signal = new AbortController().signal,
  timeoutMs = 5000,
}: RequestOptions): Promise<ElevenLabsVoicesResult> {
  let reason: ProviderListReason | undefined;
  try {
    const response = await fetchImpl(endpoint(baseUrl, '/v2/voices'), {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: requestSignal(signal, timeoutMs),
    });
    if (response.ok) {
      const voices = mapElevenLabsVoices((await response.json()) as { voices?: RawElevenLabsVoice[] });
      if (voices.length > 0) {
        return { response: { voices, source: 'account' }, fromSnapshot: false };
      }
      return premadeVoices({ baseUrl, fetchImpl, signal, timeoutMs });
    }
    reason = listFailureReason(response.status, await failureDetail(response));
  } catch {
    reason = 'unavailable';
  }
  return premadeVoices({ baseUrl, fetchImpl, signal, timeoutMs, reason });
}

/** The response-only view used by tests and callers that do not cache. */
export async function listElevenLabsVoices(options: RequestOptions): Promise<ElevenLabsVoicesResponse> {
  return (await listElevenLabsVoicesDetailed(options)).response;
}

/** The account's models; the web UI filters the text-to-speech ones. */
export async function listElevenLabsModels({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  signal = new AbortController().signal,
  timeoutMs = 5000,
}: RequestOptions): Promise<ElevenLabsModelsResponse> {
  try {
    const response = await fetchImpl(endpoint(baseUrl, '/v1/models'), {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: requestSignal(signal, timeoutMs),
    });
    if (!response.ok) {
      const reason = listFailureReason(response.status, await failureDetail(response));
      return { models: [], reason };
    }
    const body = (await response.json()) as {
      model_id?: unknown;
      name?: unknown;
      can_do_text_to_speech?: unknown;
    }[];
    return {
      models: body
        .filter((model) => typeof model.model_id === 'string')
        .map((model) => ({
          id: model.model_id as string,
          name: typeof model.name === 'string' ? model.name : (model.model_id as string),
          canDoTextToSpeech: model.can_do_text_to_speech === true,
        })),
    };
  } catch {
    return { models: [], reason: 'unavailable' };
  }
}

/** The permission name in an authentication_error body, if it names one. */
function missingPermission(detail: unknown, fallback: string): string {
  const body = detail as { detail?: { status?: unknown; message?: unknown } } | null;
  const message = typeof body?.detail?.message === 'string' ? body.detail.message : '';
  return /permission (\w+)/.exec(message)?.[1] ?? fallback;
}

/**
 * "Test key": probe the voices and models endpoints. A scoped key (most
 * ElevenLabs keys) authenticates and answers 401 `missing_permissions` for a
 * list it may not read; that is a working key for speech, so `ok` stays true
 * and the permission names are reported. Only an authentication failure
 * without `missing_permissions` is a rejected key.
 */
export async function checkElevenLabsKey({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: Omit<RequestOptions, 'signal'>): Promise<ProviderKeyCheckResult> {
  const key = apiKey.trim();
  if (key === '') return { ok: false, code: 'rejected' };
  const probes = [
    { path: '/v2/voices?page_size=1', permission: 'voices_read' },
    { path: '/v1/models', permission: 'models_read' },
  ];
  const missing = new Set<string>();
  let authenticated = false;
  for (const probe of probes) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint(baseUrl, probe.path), {
        headers: { 'xi-api-key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: 'unreachable' };
    }
    if (response.ok) {
      authenticated = true;
      void response.body?.cancel().catch(() => {});
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await failureDetail(response);
      const body = detail as { detail?: { status?: unknown } } | null;
      if (body?.detail?.status === 'missing_permissions') {
        authenticated = true;
        missing.add(missingPermission(detail, probe.permission));
        continue;
      }
      return { ok: false, code: 'rejected' };
    }
    void response.body?.cancel().catch(() => {});
    return { ok: false, code: 'unreachable' };
  }
  if (!authenticated) return { ok: false, code: 'unreachable' };
  return missing.size > 0 ? { ok: true, missingPermissions: [...missing] } : { ok: true };
}

/** The ElevenLabs-backed audio stages: plain fetch, same 24 kHz PCM as OpenAI. */
export function createElevenLabsProvider(options: ElevenLabsOptions = {}): ElevenLabsVoiceProvider {
  const baseUrl = baseOf(options.baseUrl);
  return {
    async transcribe(pcm, sampleRate, signal, current) {
      const key = keyOf(current);
      const model = current.stt.elevenlabsModel;
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(pcmToWav(pcm, sampleRate))], { type: 'audio/wav' }),
        'utterance.wav',
      );
      form.append('model_id', model);
      // Scribe labels non-speech sounds by default ("[beep]" for the Echo's
      // wake chime), and that label would become part of the request text.
      form.append('tag_audio_events', 'false');
      const languages = current.stt.languages;
      const first = languages[0];
      if (first) form.append('language_code', first);
      // Secondary languages exist only on Scribe v3; v2 takes a single hint.
      if (model === 'scribe_v3') {
        for (const language of languages.slice(1)) form.append('secondary_language_codes', language);
      }
      const response = await fetch(`${baseUrl}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
        signal: requestSignal(signal, current.elevenlabs.timeoutMs),
      });
      if (!response.ok) throw httpError('speech-to-text', response.status);
      const body = (await response.json()) as { text?: unknown };
      return typeof body.text === 'string' ? body.text.trim() : '';
    },

    sampleRate: PCM_SAMPLE_RATE,
    async *synthesize(text, signal, current) {
      const key = keyOf(current);
      const response = await fetch(
        `${baseUrl}/v1/text-to-speech/${encodeURIComponent(
          current.tts.elevenlabsVoiceId,
        )}/stream?output_format=pcm_24000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: current.tts.elevenlabsModel,
            voice_settings: {
              stability: current.tts.elevenlabsStability,
              speed: clampedSpeed(current.tts.speed),
            },
          }),
          signal: requestSignal(signal, current.elevenlabs.timeoutMs),
        },
      );
      if (!response.ok) throw httpError('text-to-speech', response.status);
      if (!response.body) throw new Error('ElevenLabs TTS response has no body');
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        yield Buffer.from(chunk);
      }
    },

    configured: (current) => Boolean(current.elevenlabs.apiKey),
    warmUp: (current) => {
      if (!current.elevenlabs.apiKey) return;
      // Open the TLS connection only: /v1/user would need user_read, which a
      // scoped key may not have even though speech works.
      fetch(`${baseUrl}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    },
  };
}
