import type { ElevenLabsModelsResponse, ElevenLabsVoicesResponse } from '@cortecho/shared';
import { listElevenLabsModels, listElevenLabsVoicesDetailed } from '../../pipeline/providers/elevenlabs.ts';
import type { SettingsStore } from '../settings/settings-store.ts';

/** How long the provider lists are cached for the pickers. */
const LISTS_TTL_MS = 10 * 60_000;
/** The built-in snapshot is only a fallback: retry the network again soon. */
const SNAPSHOT_TTL_MS = 60_000;

type Cached<T> = { key: string; at: number; ttlMs: number; value: T };

/**
 * The Providers tab's read side: ElevenLabs voices and models, cached per key.
 * An empty list carries the reason (no key, a scoped key, or unreachable), so
 * the forms can explain it instead of always blaming a missing key.
 */
export function createProvidersService({
  settings,
  baseUrl,
  fetchImpl = fetch,
  now = Date.now,
}: {
  settings: SettingsStore;
  /** ELEVENLABS_BASE_URL (environment-only), when a proxy fronts the API. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  let voicesCache: Cached<ElevenLabsVoicesResponse> | null = null;
  let modelsCache: Cached<ElevenLabsModelsResponse['models']> | null = null;

  const currentKey = (): string | null => {
    const key = settings.current().settings.elevenlabs.apiKey;
    return key ? key : null;
  };

  async function listVoices(): Promise<ElevenLabsVoicesResponse> {
    const apiKey = currentKey();
    if (!apiKey) return { voices: [], reason: 'no-key' };
    if (voicesCache && voicesCache.key === apiKey && now() - voicesCache.at < voicesCache.ttlMs) {
      return voicesCache.value;
    }
    const timeoutMs = settings.current().settings.elevenlabs.timeoutMs;
    const { response, fromSnapshot } = await listElevenLabsVoicesDetailed({
      apiKey,
      baseUrl,
      fetchImpl,
      timeoutMs,
    });
    // A transient failure must not pin an empty list. The built-in snapshot is
    // cached only briefly, so a recovered provider replaces it within a minute.
    if (response.voices.length > 0) {
      voicesCache = {
        key: apiKey,
        at: now(),
        ttlMs: fromSnapshot ? SNAPSHOT_TTL_MS : LISTS_TTL_MS,
        value: response,
      };
    }
    return response;
  }

  async function listModels(): Promise<ElevenLabsModelsResponse> {
    const apiKey = currentKey();
    if (!apiKey) return { models: [], reason: 'no-key' };
    if (modelsCache && modelsCache.key === apiKey && now() - modelsCache.at < modelsCache.ttlMs) {
      return { models: modelsCache.value };
    }
    const timeoutMs = settings.current().settings.elevenlabs.timeoutMs;
    const result = await listElevenLabsModels({ apiKey, baseUrl, fetchImpl, timeoutMs });
    if (result.models.length > 0) {
      modelsCache = { key: apiKey, at: now(), ttlMs: LISTS_TTL_MS, value: result.models };
    }
    return result;
  }

  /**
   * The sample URL for one voice, taken only from the server-side list
   * (account, anonymous premade or snapshot): a client-supplied URL is never
   * fetched (no open proxy, no SSRF).
   */
  async function previewFor(id: string): Promise<string | null> {
    const { voices } = await listVoices();
    const preview = voices.find((voice) => voice.id === id)?.previewUrl;
    if (!preview) return null;
    try {
      return new URL(preview).protocol === 'https:' ? preview : null;
    } catch {
      return null;
    }
  }

  return { listVoices, listModels, previewFor };
}
