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
import { isPrivateIpv4 } from './features/devices/host.ts';
import { importDeviceFromEnvironment, warnStaleDeviceEnvironment } from './features/devices/import.ts';
import { importSettingsFromEnvironment, warnStaleEnvironment } from './features/settings/import.ts';
import { SettingsStore } from './features/settings/settings-store.ts';
import { createTurnsRepository } from './features/turns/turns.repository.ts';
import type { VoiceRuntime } from './features/voice/voice-runtime.ts';
import { createLogger } from './lib/logger.ts';
import { AgentSessions } from './pipeline/agent-sessions.ts';
import { createOpenAiServices } from './pipeline/openai.ts';
import { ReplyAudioStore } from './pipeline/reply-audio.ts';
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
} else {
  warnStaleEnvironment();
}

// The Echoes are rows now. The old ECHO_* variables are read once to create
// the first device; after that they are ignored (echo-set-key keeps its own).
const devicesRepository = createDevicesRepository(db);
const importedDevice = importDeviceFromEnvironment(devicesRepository);
if (!importedDevice) warnStaleDeviceEnvironment();

const tools = buildToolRegistry(config);
const services = createOpenAiServices(config, tools, () => settings.current().settings);
const turns = createTurnsRepository(db);
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
});
const voice: VoiceRuntime = {
  config,
  replies,
  services,
  tools,
  turns,
  settings,
  sessions,
  devices,
  doctor: () =>
    runDoctor({
      config,
      settings,
      devices: devicesRepository.list(),
      production: isProduction,
    }),
  startedAt: new Date(),
};

if (!services.configured) log.warn('No OpenAI key is set: add one in Settings → Advanced');
const ttsModel = settings.current().settings.tts.model;
if (['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'].includes(ttsModel)) {
  log.warn(
    `TTS model "${ttsModel}" shuts down on 2027-01-06 and has no Speech API replacement; ` +
      'the Realtime API mode is on the roadmap. The current model still works until then.',
  );
}
if (devicesRepository.count() === 0) log.warn('No Echo is configured: add one with POST /api/devices');
const enabledDevices = devicesRepository.list().filter((device) => device.enabled);
if (enabledDevices.length > 0 && !config.reply.baseUrl) {
  // Inside Docker the link's local address is a container address, so the
  // first reply would play nothing. Fail before the user discovers that.
  const message =
    'REPLY_AUDIO_BASE_URL is required when an Echo is enabled: ' +
    'the Echo downloads replies from that LAN address (for example http://192.168.1.10:3000).';
  if (isProduction) throw new Error(message);
  log.warn(`${message} In development the Echo link's local address is used.`);
}
if (config.reply.baseUrl) {
  let replyUrl: URL | null = null;
  try {
    replyUrl = new URL(config.reply.baseUrl);
  } catch {
    const message = `REPLY_AUDIO_BASE_URL is not a valid URL: "${config.reply.baseUrl}"`;
    if (isProduction) throw new Error(message);
    log.warn(message);
  }
  if (replyUrl && /^\d+\.\d+\.\d+\.\d+$/.test(replyUrl.hostname) && !isPrivateIpv4(replyUrl.hostname)) {
    log.warn(
      `REPLY_AUDIO_BASE_URL (${config.reply.baseUrl}) does not look like a LAN address; ` +
        'the Echo may not be able to download replies.',
    );
  }
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
// has somewhere to go.
void devices.start();

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
    server.close((error) => {
      sqlite.close();
      if (error) {
        console.error(error);
        process.exit(1);
      }
      process.exit(0);
    });
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
