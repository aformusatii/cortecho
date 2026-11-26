import type { EchoProbeResult } from '@cortecho/shared';
import {
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  SETTING_DESCRIPTORS,
  type Settings,
} from '@cortecho/shared';
import type { Config } from '../config.ts';
import { probeEcho } from '../esphome/adopt.ts';
import type { Device } from '../features/devices/devices.repository.ts';
import { isPrivateIpv4 } from '../features/devices/host.ts';
import type { SettingsStore } from '../features/settings/settings-store.ts';
import { parseSecretKey } from '../lib/secret-box.ts';
import { effectivePolicy, type McpManager, reviewReason } from '../mcp/mcp-manager.ts';

export type DoctorInput = {
  config: Config;
  settings: SettingsStore;
  devices: Device[];
  /** Production enables the hard checks (e.g. a missing reply address). */
  production: boolean;
  /** Connector runtime and rows (optional: the CLI and old tests omit it). */
  mcp?: McpManager;
  env?: NodeJS.ProcessEnv;
  /** For tests: replace the network probes. */
  probe?: typeof probeEcho;
  fetchImpl?: typeof fetch;
  /** The address of this app as the Echo reaches it; defaults to localhost:PORT. */
  localBaseUrl?: string;
  /** With localBaseUrl, make one announcement through the running app. */
  sayText?: string;
};

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

function check(name: string, status: DoctorStatus, detail: string, fix?: string): DoctorCheck {
  return fix ? { name, status, detail, fix } : { name, status, detail };
}

/**
 * Read-only diagnostics. It never subscribes to the voice assistant and never
 * writes a setting, so it is safe to run next to a live instance.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const { config, settings, devices, production } = input;
  const env = input.env ?? process.env;
  const probe = input.probe ?? probeEcho;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = settings.current();
  const checks: DoctorCheck[] = [];

  checks.push(
    check(
      'settings',
      'pass',
      `settings v${now.version}, ${Object.keys(settings.storedValues()).length} stored value(s).`,
    ),
  );

  const hasOpenAiKey = settings.hasSecret('openai.apiKey');
  checks.push(
    check(
      'openai key',
      hasOpenAiKey ? 'pass' : 'fail',
      hasOpenAiKey ? 'An OpenAI key is stored (value never printed).' : 'No OpenAI key is stored.',
      hasOpenAiKey ? undefined : 'Add it under Settings → Providers → OpenAI API key.',
    ),
  );

  const usesElevenLabs =
    now.settings.stt.provider === 'elevenlabs' || now.settings.tts.provider === 'elevenlabs';
  if (usesElevenLabs) {
    const hasElevenLabsKey = settings.hasSecret('elevenlabs.apiKey');
    checks.push(
      check(
        'ElevenLabs key',
        hasElevenLabsKey ? 'pass' : 'fail',
        hasElevenLabsKey
          ? 'An ElevenLabs key is stored (value never printed).'
          : 'No ElevenLabs key is stored, but a stage uses ElevenLabs.',
        hasElevenLabsKey ? undefined : 'Add it under Settings → Providers → ElevenLabs API key.',
      ),
    );
    checks.push(...elevenLabsModelChecks(now.settings));
  }

  checks.push(staleEnvironmentCheck(settings, env));

  const enabled = devices.filter((device) => device.enabled);
  if (devices.length === 0) {
    checks.push(check('Echoes', 'fail', 'No Echo is configured.', 'Add one under Echos → Add Echo.'));
  } else if (enabled.length === 0) {
    checks.push(check('Echoes', 'warn', 'Every Echo is disabled.', 'Enable the one you want to use.'));
  } else {
    for (const device of enabled) {
      const result = await probe({
        host: device.host,
        port: device.port,
        apiKey: device.apiKey,
        timeoutMs: 3000,
      });
      checks.push(probeCheck(device, result));
      if (result.reachable && device.apiKey === null) {
        checks.push(
          check(
            'clock',
            'warn',
            `${device.name}: the link is plaintext, so hassmic will not set its clock.`,
            'Run `npm run echo-set-key -- --host <echo-ip>` and add the key on the Connection tab.',
          ),
        );
      }
    }
  }

  const ttsModel = now.settings.tts.model;
  if (now.settings.tts.provider !== 'openai') {
    checks.push(check('TTS voice', 'pass', `ElevenLabs speaks with ${now.settings.tts.elevenlabsVoiceId}.`));
  } else if (['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'].includes(ttsModel)) {
    checks.push(
      check(
        'TTS model',
        'warn',
        `${ttsModel} is deprecated and shuts down on 2027-01-06, and no Speech API model replaces it.`,
        'Plan the Realtime API mode (see the roadmap), or set the voice provider to ElevenLabs.',
      ),
    );
  } else {
    checks.push(check('TTS model', 'pass', `${ttsModel} is configured.`));
  }

  checks.push(await replyCheck(now.settings.network.replyBaseUrl, devices, production, fetchImpl));
  checks.push(await openAiCheck(settings, config, fetchImpl));
  if (usesElevenLabs) checks.push(await elevenLabsCheck(settings, fetchImpl));
  checks.push(...connectorChecks(config, input.mcp));

  if (input.localBaseUrl && input.sayText) {
    checks.push(await sayCheck(input.localBaseUrl, input.sayText, fetchImpl));
  }

  return {
    ok: checks.every((entry) => entry.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}

function probeCheck(device: Device, result: EchoProbeResult): DoctorCheck {
  if (!result.reachable) {
    return check(
      `Echo ${device.name}`,
      'fail',
      result.code === 'timeout'
        ? `${device.host}:${device.port} did not answer in time.`
        : result.code === 'not-esphome'
          ? `${device.host}:${device.port} answered, but not as an ESPHome device.`
          : `${device.host}:${device.port} is not reachable.`,
      'Check the address, that hassmic runs, and that PROTO=esphome.',
    );
  }
  if (result.isVoiceAssistant === false) {
    return check(
      `Echo ${device.name}`,
      'fail',
      `The device at ${device.host}:${device.port} does not offer a voice assistant.`,
      'Check that the Echo runs echo-dot-assist in ESPHome mode (PROTO=esphome).',
    );
  }
  if (result.keyState === 'set') {
    return check(
      `Echo ${device.name}`,
      'fail',
      device.apiKey === null
        ? 'The Echo requires an API key but this device has none.'
        : "The stored key is not the Echo's key.",
      device.apiKey === null
        ? "Add this Echo's API key on the Connection tab, or delete state/api_key on the Echo."
        : 'Re-run `npm run echo-set-key`, or correct the key on the Connection tab.',
    );
  }
  if (result.keyState === 'none' && device.apiKey !== null) {
    return check(
      `Echo ${device.name}`,
      'fail',
      'This device has a key but the Echo has none.',
      'Run `npm run echo-set-key -- --host <echo-ip>` and add the key on the Connection tab.',
    );
  }
  return check(
    `Echo ${device.name}`,
    'pass',
    `Connected to ${result.nodeName ?? device.host} ${device.apiKey === null ? 'in plaintext' : 'with the stored key'}.`,
  );
}

function staleEnvironmentCheck(settings: SettingsStore, env: NodeJS.ProcessEnv): DoctorCheck {
  const names = SETTING_DESCRIPTORS.filter((descriptor) => {
    if (!descriptor.env || descriptor.env === 'TZ') return false;
    if ((env[descriptor.env] ?? '').trim() === '') return false;
    // Pending, not ignored: import.ts copies it into the setting once (§8.1).
    if (descriptor.key === 'network.replyBaseUrl') {
      return settings.storedValues()[descriptor.key] !== undefined;
    }
    return true;
  }).map((descriptor) => descriptor.env as string);
  const current = settings.current().settings.assistant.timeZone;
  const tz = (env.TZ ?? '').trim();
  // TZ also sets the container clock, so it is normal to keep it. Only warn
  // when it was imported once and now differs from the stored setting.
  const importedZone = settings.storedValues()['assistant.timeZone'] !== undefined;
  if (tz && importedZone && tz !== current) names.push(`TZ (container ${tz}, setting ${current})`);

  if (names.length === 0) return check('environment', 'pass', 'No import-only variables are set.');
  return check(
    'environment',
    'warn',
    `These imported variables are ignored now: ${names.join(', ')}.`,
    'Change the values in the web UI (Settings / Echos). Only the OpenAI base URL and tool settings come from the environment.',
  );
}

async function replyCheck(
  baseUrl: string,
  devices: Device[],
  production: boolean,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const enabled = devices.filter((device) => device.enabled);
  if (!baseUrl) {
    if (production && enabled.length > 0) {
      return check(
        'reply address',
        'fail',
        'The reply address is not set, so the Echo cannot download replies.',
        "Set it under Settings → Network to this host's LAN address and port, e.g. http://192.168.1.10:3000.",
      );
    }
    return check(
      'reply address',
      'warn',
      "The reply address is not set; the Echo link's local address is used (fine for localhost development).",
      'Set it under Settings → Network for Docker: http://<docker-host-lan-ip>:3000.',
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return check(
      'reply address',
      'fail',
      `The reply address is not a valid URL: "${baseUrl}".`,
      'Set it under Settings → Network, e.g. http://192.168.1.10:3000.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return check('reply address', 'fail', 'The reply address must be http:// or https://.');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && !isPrivateIpv4(url.hostname)) {
    return check(
      'reply address',
      'fail',
      `${url.hostname} is not a LAN address. The Echo must reach this app directly on the local network.`,
      "Use the Docker host's 10.x, 172.16-31.x or 192.168.x address.",
    );
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      return check(
        'reply address',
        'fail',
        `${baseUrl}/api/health answered ${response.status}.`,
        'Check that the app is running and the port is published.',
      );
    return check('reply address', 'pass', `${baseUrl}/api/health answers from this machine.`);
  } catch (error) {
    return check(
      'reply address',
      'fail',
      `Could not reach ${baseUrl}/api/health (${error instanceof Error ? error.message : String(error)}).`,
      'Run the doctor inside the container (`docker compose exec app cortecho doctor`) and check the LAN address.',
    );
  }
}

async function openAiCheck(
  settings: SettingsStore,
  config: Config,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const key = settings.current().settings.openai.apiKey;
  if (!key) return check('OpenAI endpoint', 'skip', 'Skipped: no OpenAI key.');
  const base = config.openai.baseUrl ?? DEFAULT_OPENAI_BASE;
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403)
      return check(
        'OpenAI endpoint',
        'fail',
        `${base} rejected the API key (HTTP ${response.status}).`,
        'Enter a valid key under Settings → Providers.',
      );
    if (!response.ok)
      return check(
        'OpenAI endpoint',
        'fail',
        `${base} answered HTTP ${response.status}.`,
        'Check OPENAI_BASE_URL.',
      );
    const body = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(body?.data) ? body.data.length : 0;
    return check(
      'OpenAI endpoint',
      'pass',
      `${base} accepted the key${count > 0 ? ` and listed ${count} model(s)` : ''}.`,
    );
  } catch (error) {
    return check(
      'OpenAI endpoint',
      'fail',
      `Could not reach ${base} (${error instanceof Error ? error.message : String(error)}).`,
      'Check OPENAI_BASE_URL and the network from the container.',
    );
  }
}

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

function knownModelCheck(name: string, model: string, known: readonly string[]): DoctorCheck {
  if (known.includes(model)) return check(name, 'pass', `${model} is configured.`);
  return check(
    name,
    'warn',
    `${model} is not one of the known models (${known.join(', ')}).`,
    'Pick a known model under Settings → Voice, or keep it if ElevenLabs added it.',
  );
}

/** Model checks only for the ElevenLabs stages that are selected. */
function elevenLabsModelChecks(settings: Settings): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (settings.stt.provider === 'elevenlabs') {
    checks.push(
      knownModelCheck('ElevenLabs transcription model', settings.stt.elevenlabsModel, ELEVENLABS_STT_MODELS),
    );
  }
  if (settings.tts.provider === 'elevenlabs') {
    checks.push(
      knownModelCheck('ElevenLabs voice model', settings.tts.elevenlabsModel, ELEVENLABS_TTS_MODELS),
    );
  }
  return checks;
}

/** Listing one voice costs nothing and proves the ElevenLabs key works. */
async function elevenLabsCheck(settings: SettingsStore, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  const key = settings.current().settings.elevenlabs.apiKey;
  if (!key) return check('ElevenLabs endpoint', 'skip', 'Skipped: no ElevenLabs key.');
  try {
    const response = await fetchImpl(`${ELEVENLABS_BASE}/v2/voices?page_size=1`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    });
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403)
      return check(
        'ElevenLabs endpoint',
        'fail',
        `${ELEVENLABS_BASE} rejected the API key (HTTP ${response.status}).`,
        'Enter a valid key under Settings → Providers.',
      );
    if (!response.ok)
      return check('ElevenLabs endpoint', 'fail', `${ELEVENLABS_BASE} answered HTTP ${response.status}.`);
    return check('ElevenLabs endpoint', 'pass', `${ELEVENLABS_BASE} accepted the key.`);
  } catch (error) {
    return check(
      'ElevenLabs endpoint',
      'fail',
      `Could not reach ${ELEVENLABS_BASE} (${error instanceof Error ? error.message : String(error)}).`,
      'Check the network from the container.',
    );
  }
}

/** `--say` goes through the running app, never through a second Echo link. */
async function sayCheck(baseUrl: string, text: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return check('announcement', 'fail', `POST /api/say answered HTTP ${response.status}.`);
    return check('announcement', 'pass', `Announcement sent: “${text}”.`);
  } catch (error) {
    return check(
      'announcement',
      'fail',
      `Could not call ${baseUrl}/api/say (${error instanceof Error ? error.message : String(error)}).`,
      'Start the app first; the doctor does not open its own Echo link.',
    );
  }
}

/** Connector diagnostics: key, public URL, link state, review flags and tool budget. */
function connectorChecks(config: Config, mcp: McpManager | undefined): DoctorCheck[] {
  if (!mcp) return [];
  const rows = mcp.rows();
  if (rows.length === 0) return [check('connectors', 'skip', 'No connector is configured.')];

  const checks: DoctorCheck[] = [];
  let keyOk = false;
  let keyError: string | null = null;
  try {
    keyOk = parseSecretKey(config.mcp.secretKey) !== null;
  } catch (error) {
    keyError = error instanceof Error ? error.message : 'CORTECHO_SECRET_KEY is invalid.';
  }
  const needsSecrets = rows.some((row) => row.authType !== 'none');
  if (keyOk) {
    checks.push(check('connector key', 'pass', 'CORTECHO_SECRET_KEY is set (value never printed).'));
  } else {
    checks.push(
      check(
        'connector key',
        keyError || needsSecrets ? 'fail' : 'warn',
        keyError ??
          (needsSecrets
            ? 'CORTECHO_SECRET_KEY is missing, so connectors with headers or OAuth cannot work.'
            : 'CORTECHO_SECRET_KEY is missing; connectors without authentication still work.'),
        'Generate 32 random bytes (openssl rand -base64 32) and set CORTECHO_SECRET_KEY.',
      ),
    );
  }

  const oauthRows = rows.filter((row) => row.authType === 'oauth');
  if (oauthRows.length > 0) {
    const stored = oauthRows.filter((row) => mcp.repository.hasStoredTokens(row.id));
    const unreadable = stored.filter((row) => !mcp.repository.credentials(row.id)?.tokens);
    if (stored.length > 0) {
      checks.push(
        unreadable.length === 0
          ? check(
              'connector secrets',
              'pass',
              `${stored.length} stored token set(s) decrypt with the current key.`,
            )
          : check(
              'connector secrets',
              'fail',
              `${unreadable.map((row) => row.slug).join(', ')} cannot be decrypted: CORTECHO_SECRET_KEY changed or is wrong.`,
              'Restore the key the tokens were stored with, or sign in to those connectors again.',
            ),
      );
    }
    let valid = false;
    try {
      valid = Boolean(config.mcp.publicBaseUrl) && Boolean(new URL(config.mcp.publicBaseUrl));
    } catch {
      valid = false;
    }
    checks.push(
      valid
        ? check('connector redirect URI', 'pass', `${config.mcp.publicBaseUrl}/api/mcp/oauth/callback`)
        : check(
            'connector redirect URI',
            'warn',
            'PUBLIC_BASE_URL is not set; OAuth flows fall back to the request origin.',
            'Set it to the browser-facing URL (for example https://echo-agent.example.com).',
          ),
    );
  }

  let offered = 0;
  for (const row of rows) {
    if (!row.enabled) {
      checks.push(check(`connector ${row.slug}`, 'skip', 'Disabled.'));
      continue;
    }
    const connection = mcp.connection(row.id);
    const live = connection?.startedEver ?? false;
    const tools = mcp.repository.tools(row.id).filter((tool) => tool.present);
    const enabled = tools.filter((tool) => effectivePolicy(tool) !== 'off').length;
    const review = tools.filter((tool) => reviewReason(tool) !== null).length;
    offered += enabled;
    const state = live ? (connection?.state ?? 'connecting') : null;
    const detail = mcp.repository.statusDetail(row);
    checks.push(
      check(
        `connector ${row.slug}`,
        state === null
          ? detail.lastError
            ? 'warn'
            : 'skip'
          : state === 'connected'
            ? 'pass'
            : state === 'needs_auth'
              ? 'warn'
              : 'fail',
        state === null
          ? `not checked live; last known ${detail.lastConnectedAt ?? 'never connected'}, ${enabled}/${tools.length} tool(s) offered${review > 0 ? `, ${review} need review` : ''}${detail.lastError ? ` — ${detail.lastError.slice(0, 160)}` : ''}.`
          : `${state}, ${enabled}/${tools.length} tool(s) offered${review > 0 ? `, ${review} need review` : ''}${detail.lastError ? ` — ${detail.lastError.slice(0, 160)}` : ''}.`,
        state === null
          ? 'Run the app (GET /api/doctor) for a live connector check.'
          : state === 'connected'
            ? undefined
            : state === 'needs_auth'
              ? 'Open Settings → Connectors and sign in again.'
              : 'Check the URL, the network from the container, and the connector headers.',
      ),
    );
  }
  if (offered > 25) {
    checks.push(
      check(
        'connector tool budget',
        'warn',
        `${offered} connector tools are offered; OpenAI recommends a small set and every tool adds prompt cost.`,
        'Turn off tools you do not use, or limit connectors per Echo.',
      ),
    );
  }
  return checks;
}
