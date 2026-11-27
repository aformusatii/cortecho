import type { DeviceKind, Settings } from '@cortecho/shared';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { runDoctor } from './doctor/checks.ts';
import type { probeEcho } from './esphome/adopt.ts';
import type { EsphomeClient } from './esphome/client.ts';
import { normalizeMac } from './esphome/mac.ts';
import { DeviceManager } from './features/devices/device-manager.ts';
import { createDevicesRepository } from './features/devices/devices.repository.ts';
import { createDiscoveryRepository } from './features/discovery/discovery.repository.ts';
import { DiscoveryService } from './features/discovery/discovery.service.ts';
import type { MdnsBrowser } from './features/discovery/mdns.ts';
import type { tcpConnect } from './features/discovery/subnet.ts';
import { importSettingsFromEnvironment } from './features/settings/import.ts';
import { SettingsStore } from './features/settings/settings-store.ts';
import { createSetupRepository } from './features/setup/setup.repository.ts';
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
    sttAudio: [] as Buffer[],
    sttSettings: [] as Settings[],
    agentSettings: [] as Settings[],
    agentDevices: [] as (PromptDevice | null)[],
    agentHistory: [] as unknown[][],
    ttsSettings: [] as Settings[],
  };
  const services: VoiceServices & {
    sttResult: (pcm: Buffer) => Promise<string>;
    agentResult: (text: string, onText?: (textSoFar: string) => void) => Promise<AgentReply>;
    ttsChunks: () => Buffer[];
    calls: typeof calls;
  } = {
    calls,
    isConfigured: () => true,
    sttResult: async () => 'what time is it',
    agentResult: async () => ({ text: 'It is noon.', toolCalls: [] }),
    // 0.5 s of 24 kHz audio in 3 pieces
    ttsChunks: () => [Buffer.alloc(8000, 1), Buffer.alloc(8000, 2), Buffer.alloc(8000, 3)],
    stt: {
      transcribe: async (pcm, _sampleRate, _signal, settings) => {
        calls.stt += 1;
        calls.sttAudio.push(Buffer.from(pcm));
        calls.sttSettings.push(settings);
        return services.sttResult(pcm);
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
  /** Pre-set the learned MAC (12 hex, either spelling) to test the guard. */
  mac?: string | null;
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
  linkTimeoutMs,
  production = false,
  discovery: discoverySpec,
  fetchImpl,
}: {
  echoPort?: number;
  apiKey?: Buffer | null;
  env?: Record<string, string>;
  devices?: TestDevice[];
  /** Short adoption/secure link wait (the tests do not need 10 s). */
  linkTimeoutMs?: number;
  /** The manager's "this is a production install" signal (reply-address-missing). */
  production?: boolean;
  /** Tests only: replaces fetch for the setup wizard's OpenAI check. */
  fetchImpl?: typeof fetch;
  /** Discovery overrides; mDNS stays off unless a test passes a fake browser. */
  discovery?: {
    mdns?: MdnsBrowser | null;
    now?: () => number;
    entryTtlMs?: number;
    scanIntervalMs?: number;
    probe?: typeof probeEcho;
    connect?: typeof tcpConnect;
    connectTimeoutMs?: number;
    connectInFlight?: number;
    probeTimeoutMs?: number;
  };
} = {}) {
  // The runtime's config and its one-time settings import both read the same
  // values, as a real start does. No reply default is injected: tests use the
  // documented link fallback, and a test that needs a base URL saves the setting.
  const saved = { ...process.env };
  Object.assign(process.env, env);
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
      mac: spec.mac ? normalizeMac(spec.mac) : null,
    });
    if (spec.overrides && Object.keys(spec.overrides).length > 0) {
      settings.registerDevice(device.id, device.name, {});
      settings.applyDevice(device.id, spec.overrides, settings.version);
    }
    const withNode = spec.nodeName ? (repository.setNodeName(device.id, spec.nodeName) ?? device) : device;
    return withNode;
  });

  const turns = createTurnsRepository(db);
  const setup = createSetupRepository(db);
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
    production,
    linkTimeoutMs,
  });
  const discovery = new DiscoveryService({
    devices,
    repository: createDiscoveryRepository(db),
    extraTargets: config.discovery.extraTargets,
    replyBaseUrl: () => settings.current().settings.network.replyBaseUrl,
    mdns: discoverySpec?.mdns ?? null,
    probe: discoverySpec?.probe,
    now: discoverySpec?.now,
    entryTtlMs: discoverySpec?.entryTtlMs,
    scanIntervalMs: discoverySpec?.scanIntervalMs,
    connect: discoverySpec?.connect,
    connectTimeoutMs: discoverySpec?.connectTimeoutMs,
    connectInFlight: discoverySpec?.connectInFlight,
    probeTimeoutMs: discoverySpec?.probeTimeoutMs,
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
    discovery,
    doctor: () =>
      runDoctor({
        config,
        settings,
        devices: repository.list(),
        production: false,
        mcp,
      }),
    setup,
    startedAt: new Date(),
  };
  const app = createApp({ db, voice: runtime, fetchImpl });
  /** What the fake Echo uses to download reply audio: the URL path, through the Hono app. */
  const fetchAudio = async (url: string): Promise<Buffer> => {
    // Any reply base works (the link fallback, or the setting a test saved).
    const target = new URL(url);
    const response = await app.request(`${target.pathname}${target.search}`);
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
    discovery,
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
