import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { runDoctor } from '../doctor/checks.ts';
import { env, isProduction } from '../env.ts';
import { createDevicesRepository } from '../features/devices/devices.repository.ts';
import { SettingsStore } from '../features/settings/settings-store.ts';
import { createSecretBox, type SecretBox } from '../lib/secret-box.ts';
import { createMcpRepository } from '../mcp/mcp.repository.ts';
import { McpManager } from '../mcp/mcp-manager.ts';

/**
 * `cortecho doctor` (also `npm run doctor`). Read-only: it never changes a
 * setting, the Echo or the database. `--say` asks the running app to make one
 * announcement; it never opens a second voice-assistant subscription.
 */
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`usage: cortecho doctor [--json] [--say "text"]

Checks the configuration, the Echo links, the reply address and the OpenAI
endpoint. Exit code 1 when a check fails.`);
  process.exit(0);
}

const json = args.includes('--json');
const sayIndex = args.indexOf('--say');
const sayText = sayIndex >= 0 ? args[sayIndex + 1] : undefined;
if (sayIndex >= 0 && !sayText) {
  console.error('--say needs a text argument');
  process.exit(2);
}

const config = loadConfig();
const { db, sqlite } = openDatabase(env.DATABASE_PATH);
runMigrations(db);
const settings = new SettingsStore(db);
const devices = createDevicesRepository(db);
let secretBox: SecretBox | null = null;
try {
  secretBox = createSecretBox(config.mcp.secretKey);
} catch {
  // connectorChecks reports the bad key; the doctor must still run.
}
const mcp = new McpManager({
  repository: createMcpRepository(db, secretBox),
  publicBaseUrl: () => config.mcp.publicBaseUrl,
  cimdEnabled: config.mcp.cimdEnabled,
});

const report = await runDoctor({
  config,
  settings,
  devices: devices.list(),
  production: isProduction,
  mcp,
  localBaseUrl: sayText ? `http://127.0.0.1:${env.PORT}` : undefined,
  sayText,
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icons = { pass: '✔', warn: '!', fail: '✖', skip: '–' } as const;
  for (const entry of report.checks) {
    console.log(`${icons[entry.status]} ${entry.name}: ${entry.detail}`);
    if (entry.fix) console.log(`   fix: ${entry.fix}`);
  }
  console.log(report.ok ? '\nAll checks passed.' : '\nSome checks failed. See the fixes above.');
}

sqlite.close();
process.exit(report.ok ? 0 : 1);
