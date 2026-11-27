import { BASE_URL } from './env.ts';

/** GET /api/settings: no secret values, only `hasKeys`. */
export type SettingsDocument = {
  version: number;
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  hasKeys: Record<string, boolean>;
};

export type Provider = 'openai' | 'elevenlabs';

export async function readSettings(): Promise<SettingsDocument> {
  const response = await fetch(`${BASE_URL}/api/settings`);
  if (!response.ok) throw new Error(`GET /api/settings: HTTP ${response.status}`);
  return (await response.json()) as SettingsDocument;
}

/**
 * PATCH /api/settings with the current version. Another tab (or a previous
 * spec) may have saved first, so a 409 is retried once with the new version.
 */
export async function patchSettings(changes: Record<string, unknown>): Promise<SettingsDocument> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readSettings();
    const response = await fetch(`${BASE_URL}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: current.version, changes }),
    });
    if (response.ok) return (await response.json()) as SettingsDocument;
    const detail = await response.text();
    if (response.status === 409 && attempt === 0) continue;
    throw new Error(`PATCH /api/settings ${response.status}: ${detail}`);
  }
}

/** The audio stages this suite switches between combinations. */
export async function setProviders(stt: Provider, tts: Provider): Promise<void> {
  await patchSettings({ 'stt.provider': stt, 'tts.provider': tts });
}

/** A dummy key: the gateway replaces it with the real one in real mode. */
export const DUMMY_ELEVENLABS_KEY = 'e2e-elevenlabs-key';
/** A sentinel that asks the mock gateway for a scoped-key (401) answer. */
export const MISSING_PERMISSIONS_KEY = 'missing-permissions-key';
