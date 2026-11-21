/**
 * One-time setup, run by the owner (never by the app): gives the Echo its
 * ESPHome API key, the way Home Assistant does when it adopts a device.
 *
 *   npm run echo-set-key -- --host 192.168.1.50 [--env-file cortecho.env]
 *
 * With no ECHO_API_KEY in the environment or --key, it generates a 32-byte key,
 * sends it to the Echo, writes ECHO_API_KEY into the env file (mode 0600) and
 * never prints it. Then add the same key on the Echo's Connection tab.
 *
 * The handshake lives in esphome/adopt.ts, shared with the web adoption flow
 * (spec §7.1 S5). It connects with Noise and the all-zero PSK (what hassmic
 * accepts while it has no key) and sends NoiseEncryptionSetKeyRequest; hassmic
 * stores the key in state/api_key. From then on only clients with that key get
 * in, and it takes their time for its clock.
 *
 * This CHANGES THE ECHO. Undo: delete /data/local/hassmic/state/api_key on the
 * Echo and restart hassmic (`stop hassmic; start hassmic`).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { REPO_ROOT } from '../env.ts';
import { setKeyOnUnkeyedEcho } from '../esphome/adopt.ts';
import { parseApiKey } from '../esphome/noise.ts';
import { writeEnvFile } from './env-file.ts';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const host = option('host') ?? process.env.ECHO_HOST?.trim();
const port = Number(option('port') ?? process.env.ECHO_PORT?.trim() ?? 26053);
// npm runs workspace scripts from apps/api, so the default file must be
// resolved from the repository root, not the current directory.
const envFile = path.resolve(REPO_ROOT, option('env-file') ?? 'cortecho.env');
const providedKey = option('key') ?? process.env.ECHO_API_KEY?.trim();

if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`usage: npm run echo-set-key -- --host <echo-ip> [--port 26053] [--env-file cortecho.env]

Add --key <base64> to use an existing key; otherwise one is generated and
written to the env file. This changes the Echo.`);
  process.exit(2);
}

const keyText = providedKey || randomBytes(32).toString('base64');
parseApiKey(keyText); // validates; throws on a bad key

function fail(message: string): never {
  console.error(`echo-set-key: ${message}`);
  process.exit(1);
}

const outcome = await setKeyOnUnkeyedEcho({
  host,
  port,
  key: keyText,
  clientInfo: 'echo-set-key',
  onHello: (name) => console.log(`connected to ${name}; sending the key`),
});

if (outcome === 'refused') {
  fail(
    'the Echo refused the key: it already has one (or rejected this one). ' +
      'Delete state/api_key on the Echo first if you want to replace it.',
  );
}
if (outcome === 'unreachable') {
  fail(`no encrypted link to ${host}:${port}: nothing was sent.`);
}
if (outcome === 'lost') {
  fail(
    'the Echo did not answer after the key was sent: it may have stored it. ' +
      'Check the Echo, then try to connect before running this again.',
  );
}

if (!providedKey) writeEnvFile(envFile, 'ECHO_API_KEY', keyText);
console.log(
  `the Echo stored the key: only encrypted connections with it from now on. ` +
    (providedKey
      ? 'The key was provided, so no file was written.'
      : `It was written to ${envFile} (mode 0600) and is never printed here.`),
);
