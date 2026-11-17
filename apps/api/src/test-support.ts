import type { DeviceKind, Settings } from '@cortecho/shared';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { runDoctor } from './doctor/checks.ts';
import type { EsphomeClient } from './esphome/client.ts';
import { DeviceManager } from './features/devices/device-manager.ts';
import { createDevicesRepository } from './features/devices/devices.repository.ts';
import { importSettingsFromEnvironment } from './features/settings/import.ts';
import { SettingsStore } from './features/settings/settings-store.ts';
import { createTurnsRepository } from './features/turns/turns.repository.ts';
import type { VoiceRuntime } from './features/voice/voice-runtime.ts';
import { createSecretBox } from './lib/secret-box.ts';
import { createMcpRepository } from './mcp/mcp.repository.ts';
import { McpManager } from './mcp/mcp-manager.ts';
import { McpToolSource } from './mcp/mcp-tool-source.ts';
import { AgentSessions } from './pipeline/agent-sessions.ts';
import type { PromptDevice } from './pipeline/prompt-layers.ts';
import { ReplyAudioStore } from './pipeline/reply-audio.ts';
import type { AgentReply, VoiceServices } from './pipeline/services.ts';
import type { VoicePipeline } from './pipeline/voice-pipeline.ts';
import { buildToolRegistry } from './tools/index.ts';

/**
 * Test doubles for the AI services. Every call is recorded; behaviour can be
 * swapped per test (e.g. make STT throw). The settings passed per call are
 * recorded too, so a test can assert which Echo's snapshot reached TTS.
 */
export function fakeServices() {
  const calls = {
    stt: 0,
    agent: [] as string[],
    tts: [] as string[],
    sttSettings: [] as Settings[],
    agentSettings: [] as Settings[],
    agentDevices: [] as (PromptDevice | null)[],
    agentHistory: [] as unknown[][],
    ttsSettings: [] as Settings[],
  };
  const services: VoiceServices & {
    sttResult: () => Promise<string>;
    agentResult: (text: string, onText?: (textSoFar: string) => void) => Promise<AgentReply>;
    ttsChunks: () => Buffer[];
    calls: typeof calls;
  } = {
    calls,
    configured: true,
    sttResult: async () => 'what time is it',
    agentResult: async () => ({ text: 'It is noon.', toolCalls: [] }),
    // 0.5 s of 24 kHz audio in 3 pieces
    ttsChunks: () => [Buffer.alloc(8000, 1), Buffer.alloc(8000, 2), Buffer.alloc(8000, 3)],
    stt: {
      transcribe: async (_pcm, _sampleRate, _signal, settings) => {
        calls.stt += 1;
        calls.sttSettings.push(settings);
        return services.sttResult();
      },
    },
    agent: {
      reply: async (text, _signal, onText, context) => {
        calls.agent.push(text);
        calls.agentSettings.push(context.settings);
        calls.agentDevices.push(context.device ?? null);
        calls.agentHistory.push(context.session.history.map((item) => ({ ...item })));
        // Approximate the real agent: the conversation is replayed per speaker,
        // so a turn must only see its own session's history.
        context.session.history.push({ role: 'user', content: text });
        return services.agentResult(text, onText);
      },
      reset: () => {},
    },
    tts: {
      sampleRate: 24000,
      async *synthesize(text, _signal, settings) {
        calls.tts.push(text);
        calls.ttsSettings.push(settings);
        for (const chunk of services.ttsChunks()) yield chunk;
      },
    },
  };
  return services;
}

/** Base of reply URLs in tests; the fake Echo maps them onto `app.request`. */
export const TEST_REPLY_BASE_URL = 'http://voice-agent.test';

/** One device to create for a test runtime. */
export type TestDevice = {
  name?: string;
  kind?: DeviceKind;
  host?: string;
  port: number;
  /** A Buffer of 32 bytes or the base64 string as entered. */
  apiKey?: Buffer | string | null;
  enabled?: boolean;
  prompt?: string;
  overrides?: Record<string, unknown>;
  /** Pre-set the learned node name (to test the unexpected-device guard). */
  nodeName?: string;
};

/**
 * A full runtime (in-memory db, real ESPHome client and HTTP app) with one
 * runtime per device. Links are **not** started: existing tests call
 * `ctx.client.start()`; multi-Echo tests call `await ctx.startDevices()`.
 * The `echoPort` shorthand creates one plain device named "Echo".
 */
export function createTestRuntime({
  echoPort,
  apiKey = null,
  env = {},
  devices: deviceSpecs,
}: {
  echoPort?: number;
  apiKey?: Buffer | null;
  env?: Record<string, string>;
  devices?: TestDevice[];
} = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    REPLY_AUDIO_BASE_URL: TEST_REPLY_BASE_URL,
    ...env,
  });
  const config = loadConfig();

  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  // The environment values are the one-time import, as in production. No
  // SystemPrompt.md: tests must not depend on the developer's prompt file.
  const settings = new SettingsStore(db);
  importSettingsFromEnvironment(settings, { promptFile: null, env });
  process.env = saved;

  const repository = createDevicesRepository(db);
  const specs: TestDevice[] =
    deviceSpecs ?? (echoPort === undefined ? [] : [{ name: 'Echo', port: echoPort, apiKey }]);
  const created = specs.map((spec) => {
    const key =
      spec.apiKey === undefined || spec.apiKey === null
        ? null
        : typeof spec.apiKey === 'string'
          ? spec.apiKey
          : spec.apiKey.toString('base64');
    const device = repository.create({
      name: spec.name ?? 'Echo',
      kind: spec.kind ?? 'echo',
      host: spec.host ?? '127.0.0.1',
      port: spec.port,
      apiKey: key,
      enabled: spec.enabled ?? true,
      prompt: spec.prompt ?? '',
    });
    if (spec.overrides && Object.keys(spec.overrides).length > 0) {
      settings.registerDevice(device.id, device.name, {});
      settings.applyDevice(device.id, spec.overrides, settings.version);
    }
    const withNode = spec.nodeName ? (repository.setNodeName(device.id, spec.nodeName) ?? device) : device;
    return withNode;
  });

  const turns = createTurnsRepository(db);
  const services = fakeServices();
  const tools = buildToolRegistry(config);
  const secretBox = createSecretBox(config.mcp.secretKey);
  const mcpRepository = createMcpRepository(db, secretBox);
  const mcp = new McpManager({
    repository: mcpRepository,
    publicBaseUrl: () => config.mcp.publicBaseUrl,
    cimdEnabled: config.mcp.cimdEnabled,
  });
  tools.addSource(new McpToolSource({ manager: mcp }));
  const replies = new ReplyAudioStore(config.reply.ttlMs);
  const sessions = new AgentSessions();
  const devices = new DeviceManager({
    repository,
    settings,
    services,
    turns,
    replies,
    sessions,
    config,
    tools,
  });
  const runtime: VoiceRuntime = {
    config,
    replies,
    services,
    tools,
    turns,
    mcp,
    settings,
    sessions,
    devices,
    doctor: () =>
      runDoctor({
        config,
        settings,
        devices: repository.list(),
        production: false,
        mcp,
      }),
    startedAt: new Date(),
  };
  const app = createApp({ db, voice: runtime });
  /** What the fake Echo uses to download reply audio: the URL path, through the Hono app. */
  const fetchAudio = async (url: string): Promise<Buffer> => {
    const response = await app.request(url.replace(TEST_REPLY_BASE_URL, ''));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  // The first device's pieces keep the single-Echo tests readable.
  const first = created[0] ?? null;
  const firstRuntime = first ? devices.runtime(first.id) : null;
  return {
    runtime,
    app,
    fetchAudio,
    db,
    sqlite,
    services,
    repository,
    devices,
    mcp,
    mcpRepository,
    sessions,
    turns,
    replies,
    settings,
    created,
    // Convenience for the single-Echo tests; absent only when no device was created.
    client: firstRuntime?.client as unknown as EsphomeClient,
    pipeline: firstRuntime?.pipeline as unknown as VoicePipeline,
    /** Starts every enabled device's link (the manager does this at server start). */
    startDevices: () => devices.start(),
    /** Starts the enabled connectors too (when a test needs them). */
    startConnectors: () => mcp.start(),
  };
}

export async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
