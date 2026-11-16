import {
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  SETTING_DESCRIPTORS,
} from '@cortecho/shared';
import type { Config } from '../config.ts';
import type { Device } from '../features/devices/devices.repository.ts';
import { isPrivateIpv4 } from '../features/devices/host.ts';
import type { SettingsStore } from '../features/settings/settings-store.ts';
import { type EchoProbeResult, probeEcho } from './probe.ts';

export type DoctorInput = {
  config: Config;
  settings: SettingsStore;
  devices: Device[];
  /** Production enables the hard checks (e.g. a missing reply address). */
  production: boolean;
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
      hasOpenAiKey ? undefined : 'Add it under Settings → Advanced → OpenAI API key.',
    ),
  );

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
  if (['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'].includes(ttsModel)) {
    checks.push(
      check(
        'TTS model',
        'warn',
        `${ttsModel} is deprecated and shuts down on 2027-01-06, and no Speech API model replaces it.`,
        'Plan the Realtime API mode (see the roadmap); until then the current model still works.',
      ),
    );
  } else {
    checks.push(check('TTS model', 'pass', `${ttsModel} is configured.`));
  }

  checks.push(await replyCheck(config, devices, production, fetchImpl));
  checks.push(await openAiCheck(settings, config, fetchImpl));

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
  const status: DoctorStatus =
    result.reachable && result.problem === undefined
      ? 'pass'
      : result.problem === 'unreachable'
        ? 'fail'
        : 'fail';
  const fix =
    result.problem === 'encryption-required'
      ? "Add this Echo's API key on the Connection tab, or delete state/api_key on the Echo."
      : result.problem === 'invalid-key'
        ? "The stored key is not the Echo's key. Re-run echo-set-key or correct the key."
        : result.problem === 'key-not-set'
          ? 'The device has a key but the Echo has none: run `npm run echo-set-key -- --host <echo-ip>`.'
          : result.problem === 'unreachable' || result.problem === 'timeout'
            ? 'Check the address, that hassmic runs, and that PROTO=esphome.'
            : undefined;
  return check(`Echo ${device.name}`, status, result.message, fix);
}

function staleEnvironmentCheck(settings: SettingsStore, env: NodeJS.ProcessEnv): DoctorCheck {
  const names = SETTING_DESCRIPTORS.filter(
    (descriptor) => descriptor.env && descriptor.env !== 'TZ' && (env[descriptor.env] ?? '').trim() !== '',
  ).map((descriptor) => descriptor.env as string);
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
    'Change the values in the web UI (Settings / Echos). Only reply/OpenAI base URLs and tool settings come from the environment.',
  );
}

async function replyCheck(
  config: Config,
  devices: Device[],
  production: boolean,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const enabled = devices.filter((device) => device.enabled);
  if (!config.reply.baseUrl) {
    if (production && enabled.length > 0) {
      return check(
        'reply address',
        'fail',
        'REPLY_AUDIO_BASE_URL is empty, so the Echo cannot download replies.',
        "Set it to this host's LAN address and port, e.g. http://192.168.1.10:3000.",
      );
    }
    return check(
      'reply address',
      'warn',
      "REPLY_AUDIO_BASE_URL is empty; the Echo link's local address is used (fine for localhost development).",
      'Set it for Docker: http://<docker-host-lan-ip>:3000.',
    );
  }

  let url: URL;
  try {
    url = new URL(config.reply.baseUrl);
  } catch {
    return check(
      'reply address',
      'fail',
      `REPLY_AUDIO_BASE_URL is not a valid URL: "${config.reply.baseUrl}".`,
      'Use a full URL, e.g. http://192.168.1.10:3000.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return check('reply address', 'fail', 'REPLY_AUDIO_BASE_URL must be http:// or https://.');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && !isPrivateIpv4(url.hostname)) {
    return check(
      'reply address',
      'fail',
      `${url.hostname} is not a LAN address. The Echo must reach this app directly on the local network.`,
      "Use the Docker host's 10.x, 172.16-31.x or 192.168.x address.",
    );
  }

  try {
    const response = await fetchImpl(`${config.reply.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      return check(
        'reply address',
        'fail',
        `${config.reply.baseUrl}/api/health answered ${response.status}.`,
        'Check that the app is running and the port is published.',
      );
    return check('reply address', 'pass', `${config.reply.baseUrl}/api/health answers from this machine.`);
  } catch (error) {
    return check(
      'reply address',
      'fail',
      `Could not reach ${config.reply.baseUrl}/api/health (${error instanceof Error ? error.message : String(error)}).`,
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
        'Enter a valid key under Settings → Advanced.',
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
