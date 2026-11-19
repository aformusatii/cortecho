import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run smoke:init` — generates the simulated Echo's identity once and
 * writes `smoke/.env.smoke` from the example. The API key is a 32-byte base64
 * Noise key; the node name has the real form (`echo-dot-2-<6 hex>`) with a
 * value that differs from the real Echo's, so Cortecho sees two devices.
 *
 * The file is never overwritten unless `--force` is given; add your own
 * `SMOKE_OPENAI_API_KEY` by hand afterwards.
 */

const SMOKE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENV_PATH = path.join(SMOKE_DIR, '.env.smoke');
const EXAMPLE_PATH = path.join(SMOKE_DIR, '.env.smoke.example');

const force = process.argv.includes('--force');

if (existsSync(ENV_PATH) && !force) {
  console.error('smoke/.env.smoke already exists; re-run with --force to overwrite.');
  process.exit(1);
}

const apiKey = randomBytes(32).toString('base64');
const macSuffix = randomBytes(3).toString('hex'); // 6 hex chars
const nodeName = `echo-dot-2-${macSuffix}`;
const mac = `02:${macSuffix.match(/.{2}/g)?.join(':') ?? ''}`;

let content = readFileSync(EXAMPLE_PATH, 'utf8');
content = content
  .replace(/^SMOKE_ECHO_API_KEY=.*$/m, `SMOKE_ECHO_API_KEY=${apiKey}`)
  .replace(/^SMOKE_ECHO_NODE_NAME=.*$/m, `SMOKE_ECHO_NODE_NAME=${nodeName}`)
  .replace(/^SMOKE_ECHO_MAC=.*$/m, `SMOKE_ECHO_MAC=${mac}`);
writeFileSync(ENV_PATH, content);

console.log(`wrote smoke/.env.smoke (node name ${nodeName}). Add SMOKE_OPENAI_API_KEY before running.`);
