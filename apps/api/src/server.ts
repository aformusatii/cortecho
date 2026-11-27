import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { runDoctor } from './doctor/checks.ts';
import { env, isProduction, REPO_ROOT } from './env.ts';
import { DeviceManager } from './features/devices/device-manager.ts';
import { createDevicesRepository } from './features/devices/devices.repository.ts';
import { importDeviceFromEnvironment, warnStaleDeviceEnvironment } from './features/devices/import.ts';
import { createDiscoveryRepository } from './features/discovery/discovery.repository.ts';
import { DiscoveryService } from './features/discovery/discovery.service.ts';
import { createBonjourBrowser } from './features/discovery/mdns.ts';
import {
  importSettingsFromEnvironment,
  migrateReplyBaseUrlFromEnvironment,
  warnStaleEnvironment,
} from './features/settings/import.ts';
import { SettingsStore } from './features/settings/settings-store.ts';
import { createSetupRepository } from './features/setup/setup.repository.ts';
import { createTurnsRepository } from './features/turns/turns.repository.ts';
import type { VoiceRuntime } from './features/voice/voice-runtime.ts';
import { createLogger } from './lib/logger.ts';
import { createSecretBox, type SecretBox } from './lib/secret-box.ts';
import { createMcpRepository } from './mcp/mcp.repository.ts';
import { McpManager } from './mcp/mcp-manager.ts';
import { McpToolSource } from './mcp/mcp-tool-source.ts';
import { AgentSessions } from './pipeline/agent-sessions.ts';
import { ReplyAudioStore } from './pipeline/reply-audio.ts';
import { missingProviders } from './pipeline/services.ts';
import { createVoiceServices } from './pipeline/voice-services.ts';
import { buildToolRegistry } from './tools/index.ts';

const log = createLogger('server');
const config = loadConfig();

const { db, sqlite } = openDatabase(env.DATABASE_PATH);

// Migrating on every start is safe (already-applied migrations are skipped)
// and means a fresh Docker volume or clone never runs against an old schema.
runMigrations(db);

// Settings live in SQLite and in memory. The environment is read once, for
// the import; after that the store is the only source. Turns read a snapshot.
const settings = new SettingsStore(db);
const imported = importSettingsFromEnvironment(settings);
if (imported) {
  log.info(`settings imported from the environment: ${imported.imported.join(', ') || '(none)'}`);
  for (const block of imported.dropped)
    log.info(`prompt import dropped a code-owned block: "${block.slice(0, 60)}…"`);
}
// An older deployment has the reply address only in REPLY_AUDIO_BASE_URL and a
// used database, so the one-time import never copies it. Runs before the stale
// warning, which lists the variable only once the setting exists.
migrateReplyBaseUrlFromEnvironment(settings);
if (!imported) warnStaleEnvironment(settings);

// The Echoes are rows now. The old ECHO_* variables are read once to create
// the first device; after that they are ignored (echo-set-key keeps its own).
const devicesRepository = createDevicesRepository(db);
const importedDevice = importDeviceFromEnvironment(devicesRepository);
if (!importedDevice) warnStaleDeviceEnvironment();

const tools = buildToolRegistry(config);
// Connector secrets are encrypted at rest with CORTECHO_SECRET_KEY. A missing
// key leaves connectors with auth_type none working; an invalid one is logged
// and treated as missing (the doctor says what to fix).
let secretBox: SecretBox | null = null;
try {
  secretBox = createSecretBox(config.mcp.secretKey);
} catch (error) {
  log.error(`CORTECHO_SECRET_KEY is invalid: ${(error as Error).message}`);
}
const mcpRepository = createMcpRepository(db, secretBox);
const mcp = new McpManager({
  repository: mcpRepository,
  publicBaseUrl: () => config.mcp.publicBaseUrl,
  cimdEnabled: config.mcp.cimdEnabled,
});
tools.addSource(new McpToolSource({ manager: mcp }));
const services = createVoiceServices(config, tools);
const turns = createTurnsRepository(db);
const setup = createSetupRepository(db);
const replies = new ReplyAudioStore(config.reply.ttlMs);
// One conversation memory for the whole process; each speaker has its own key
// (`device:<id>` for an Echo, `web` for /api/ask without one).
const sessions = new AgentSessions();

const devices = new DeviceManager({
  repository: devicesRepository,
  settings,
  services,
  turns,
  replies,
  sessions,
  config,
  tools,
});
// Discovery is memory-only and must never block startup: mDNS failures are a
// warning, the subnet scan runs in the background after the server is up.
const discovery = new DiscoveryService({
  devices,
  repository: createDiscoveryRepository(db),
  extraTargets: config.discovery.extraTargets,
  replyBaseUrl: () => settings.current().settings.network.replyBaseUrl,
  mdns: createBonjourBrowser(),
});
const voice: VoiceRuntime = {
  config,
  replies,
  services,
  tools,
  turns,
  mcp,
  settings,
  sessions,
  devices,
  discovery,
  doctor: () =>
    runDoctor({
      config,
      settings,
      devices: devicesRepository.list(),
      production: isProduction,
      mcp,
    }),
  setup,
  startedAt: new Date(),
};

for (const provider of missingProviders(settings.current().settings)) {
  log.warn(
    `No ${provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} key is set: add one in Settings → Providers`,
  );
}
const currentSettings = settings.current().settings;
const ttsModel = currentSettings.tts.model;
if (
  currentSettings.tts.provider === 'openai' &&
  ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'].includes(ttsModel)
) {
  log.warn(
    `TTS model "${ttsModel}" shuts down on 2027-01-06 and has no Speech API replacement; ` +
      'the Realtime API mode is on the roadmap. The current model still works until then.',
  );
}
if (devicesRepository.count() === 0) log.warn('No Echo is configured: add one with POST /api/devices');
log.info(
  `connectors: ${
    mcpRepository
      .list()
      .map((row) => `${row.slug}${row.enabled ? '' : ' (off)'}`)
      .join(', ') || '(none)'
  }`,
);
const enabledDevices = devicesRepository.list().filter((device) => device.enabled);
if (
  isProduction &&
  enabledDevices.some((device) => device.kind === 'echo') &&
  !settings.current().settings.network.replyBaseUrl
) {
  // Not fatal any more (spec §8.1): the device shows `reply-address-missing`
  // and Settings → Network fixes it. Inside Docker the link's local address is
  // a container address, so replies would play nothing until then.
  log.warn(
    "the reply address is not set: Echos cannot download their answers until Settings → Network has this computer's address",
  );
}
log.info(`tools: ${tools.names.join(', ') || '(none)'}`);
log.info(
  `devices: ${
    devicesRepository
      .list()
      .map((device) => `${device.name} (${device.host}:${device.port})`)
      .join(', ') || '(none)'
  }`,
);

const app = createApp({
  db,
  voice,
  enableCors: !isProduction,
  logRequests: env.NODE_ENV !== 'test',
  webDistDir: isProduction ? path.join(REPO_ROOT, 'apps/web/dist') : undefined,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`API listening on http://${env.HOST}:${info.port} (${env.NODE_ENV}, db: ${env.DATABASE_PATH})`);
});

// Start the links after the routes exist, so a turn that arrives immediately
// has somewhere to go. Connectors connect in parallel: their tools are not
// needed until the first turn.
void devices.start();
void mcp.start();
discovery.start();

// Graceful shutdown: `docker stop` sends SIGTERM, Ctrl+C sends SIGINT.
// Stop the Echo links, let in-flight requests finish, then close the database.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);

  // If something hangs, do not keep the container alive forever.
  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  void devices.stopAll().finally(() => {
    discovery.stop();
    void mcp.stopAll().finally(() => {
      server.close((error) => {
        sqlite.close();
        if (error) {
          console.error(error);
          process.exit(1);
        }
        process.exit(0);
      });
    });
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
