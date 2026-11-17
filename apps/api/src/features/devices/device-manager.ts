import type { DeviceStatus, EchoProblem } from '@cortecho/shared';
import type { Config } from '../../config.ts';
import { env } from '../../env.ts';
import { EsphomeClient } from '../../esphome/client.ts';
import type { DeviceInfo } from '../../esphome/messages.ts';
import { parseApiKey } from '../../esphome/noise.ts';
import { posixTimezone } from '../../esphome/timezone.ts';
import { createLogger, errorMessage } from '../../lib/logger.ts';
import type { AgentSessions } from '../../pipeline/agent-sessions.ts';
import type { ReplyAudioStore } from '../../pipeline/reply-audio.ts';
import type { VoiceServices } from '../../pipeline/services.ts';
import { VoicePipeline } from '../../pipeline/voice-pipeline.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { SettingsStore } from '../settings/settings-store.ts';
import type { TurnsRepository } from '../turns/turns.repository.ts';
import type { Device, DevicesRepository } from './devices.repository.ts';
import { resolveHost } from './host.ts';

const log = createLogger('devices');

/** One Echo's live pieces. `device` is replaced on rename/prompt edits, so read it per use. */
export type DeviceRuntime = {
  device: Device;
  client: EsphomeClient;
  pipeline: VoicePipeline;
  /** The node name the Echo reported at its last connect (for "accept new device"). */
  reportedNodeName: string | null;
};

export type DeviceManagerOptions = {
  repository: DevicesRepository;
  settings: SettingsStore;
  services: VoiceServices;
  turns: TurnsRepository;
  replies: ReplyAudioStore;
  sessions: AgentSessions;
  config: Pick<Config, 'reply' | 'debug'>;
  /** Plugins + connectors, snapshotted per turn. */
  tools: ToolRegistry;
};

/** POST /api/devices/:id/accept-device without a reported name. */
export class NoReportedDeviceError extends Error {
  constructor() {
    super('This Echo has not reported a node name yet.');
    this.name = 'NoReportedDeviceError';
  }
}

/**
 * Owns one runtime per Echo: its client and pipeline. Starting, stopping and
 * replacing is per device, so a change to one Echo never disturbs another.
 * The manager also keeps the identity checks: the node name learned at the
 * first connect, the "unexpected device" guard and duplicate node names.
 */
export class DeviceManager {
  private readonly options: DeviceManagerOptions;
  /** The rows; the routes use it for CRUD, the manager for its lifecycle. */
  readonly repository: DevicesRepository;
  private readonly runtimes = new Map<number, DeviceRuntime>();
  /** Problems the manager found itself; they win over the client's. */
  private readonly problems = new Map<number, EchoProblem>();
  private started = false;

  constructor(options: DeviceManagerOptions) {
    this.options = options;
    this.repository = options.repository;
    for (const device of options.repository.list()) {
      options.settings.registerDevice(device.id, device.name, device.overrides);
      this.runtimes.set(device.id, this.createRuntime(device));
    }
  }

  /** Starts every enabled device. Call once, after the routes are built. */
  async start(): Promise<void> {
    this.started = true;
    await Promise.all(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.device.enabled)
        .map((runtime) => this.startRuntime(runtime)),
    );
  }

  async stopAll(): Promise<void> {
    this.started = false;
    await Promise.all([...this.runtimes.values()].map((runtime) => this.stopRuntime(runtime)));
  }

  /** Every known device, as rows (fresh overrides, key included: never send these out). */
  listDevices(): Device[] {
    return this.options.repository.list();
  }

  /** Every known device as status, in device order. */
  list(): DeviceStatus[] {
    return this.listDevices().map((device) => this.status(device));
  }

  /** The live runtime, if the device exists (enabled or not: ask works without a link). */
  runtime(deviceId: number): DeviceRuntime | null {
    return this.runtimes.get(deviceId) ?? null;
  }

  pipeline(deviceId: number): VoicePipeline | null {
    return this.runtimes.get(deviceId)?.pipeline ?? null;
  }

  /** The current row for a device (a runtime's copy may be older). */
  device(deviceId: number): Device | null {
    return this.options.repository.get(deviceId) ?? this.runtimes.get(deviceId)?.device ?? null;
  }

  /** Adds a new device: starts its link when enabled. */
  async add(device: Device): Promise<void> {
    this.options.settings.registerDevice(device.id, device.name, device.overrides);
    const runtime = this.createRuntime(device);
    this.runtimes.set(device.id, runtime);
    if (this.started && device.enabled) await this.startRuntime(runtime);
  }

  /**
   * Applies an edit. Only host, port, key or enabled need a new link; a
   * rename or a new prompt reaches the next turn through `runtime.device`.
   */
  async update(before: Device, after: Device): Promise<void> {
    const runtime = this.runtimes.get(after.id);
    const linkChanged =
      before.host !== after.host ||
      before.port !== after.port ||
      before.apiKey !== after.apiKey ||
      before.enabled !== after.enabled;
    this.options.settings.renameDevice(after.id, after.name);

    if (!runtime) {
      const created = this.createRuntime(after);
      this.runtimes.set(after.id, created);
      if (this.started && after.enabled) await this.startRuntime(created);
      return;
    }

    if (!linkChanged) {
      runtime.device = after;
      this.recomputeDuplicateNames();
      return;
    }

    // Replacing a runtime: stop the old client before the new one opens a link.
    await this.stopRuntime(runtime);
    const replaced = this.createRuntime(after);
    this.runtimes.set(after.id, replaced);
    if (this.started && after.enabled) await this.startRuntime(replaced);
  }

  /** Drops and reopens the link (after `echo-set-key`, or from the UI). */
  async reconnect(deviceId: number): Promise<boolean> {
    const runtime = this.runtimes.get(deviceId);
    if (!runtime) return false;
    await this.stopRuntime(runtime);
    const fresh = this.createRuntime(runtime.device);
    this.runtimes.set(deviceId, fresh);
    if (fresh.device.enabled) await this.startRuntime(fresh);
    return true;
  }

  /** Deletes a device's runtime: a running turn is aborted and its reply revoked. */
  async remove(deviceId: number): Promise<void> {
    const runtime = this.runtimes.get(deviceId);
    this.runtimes.delete(deviceId);
    this.problems.delete(deviceId);
    this.options.settings.removeDevice(deviceId);
    if (runtime) await this.stopRuntime(runtime);
    this.recomputeDuplicateNames();
  }

  /** "Accept new device": stores the node name the Echo reported and reconnects. */
  async acceptDevice(deviceId: number): Promise<Device> {
    const runtime = this.runtimes.get(deviceId);
    const reported = runtime?.reportedNodeName ?? null;
    if (!reported) throw new NoReportedDeviceError();
    const updated = this.options.repository.setNodeName(deviceId, reported);
    if (!updated) throw new Error('No such device.');
    this.problems.delete(deviceId);
    if (runtime) {
      runtime.device = updated;
      await runtime.client.stop();
      if (updated.enabled) runtime.client.start();
    } else {
      const created = this.createRuntime(updated);
      this.runtimes.set(deviceId, created);
      if (this.started && updated.enabled) await this.startRuntime(created);
    }
    this.recomputeDuplicateNames();
    return updated;
  }

  /** The status document for one device (live bits from its runtime). */
  status(device: Device): DeviceStatus {
    const runtime = this.runtimes.get(device.id);
    const client = runtime?.client;
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      host: device.host,
      port: device.port,
      enabled: device.enabled,
      prompt: device.prompt,
      nodeName: device.nodeName,
      hasKey: device.apiKey !== null,
      state: device.enabled ? (client?.state ?? 'disconnected') : 'disabled',
      encryption: device.apiKey ? 'noise' : 'plaintext',
      problem: this.problems.get(device.id) ?? client?.problem ?? null,
      connectedSince: client?.connectedSince?.toISOString() ?? null,
      lastPongAt: client?.lastPongAt?.toISOString() ?? null,
      reconnects: client?.reconnects ?? 0,
      lastTimeSyncAt: client?.lastTimeSyncAt?.toISOString() ?? null,
      info: client?.echoInfo ?? null,
      pipeline: { state: runtime?.pipeline.state ?? 'idle' },
      overrideCount: Object.keys(device.overrides).length,
    };
  }

  // -------------------------------------------------------------------------

  private createRuntime(device: Device): DeviceRuntime {
    const { settings, config, services, turns, replies, sessions, tools } = this.options;
    let apiKey: Buffer | null = null;
    if (device.apiKey) {
      try {
        apiKey = parseApiKey(device.apiKey);
      } catch (error) {
        log.error(
          `device "${device.name}" has an invalid key; connecting in plaintext: ${errorMessage(error)}`,
        );
      }
    }
    const snapshot = () => settings.forDevice(device.id);
    const client = new EsphomeClient({
      host: device.host,
      port: device.port,
      apiKey,
      clientInfo: 'cortecho',
      // Checked before every (re)connect, and the client connects to the literal.
      resolveHost,
      reconnectMinMs: () => snapshot().settings.echo.reconnectMinMs,
      reconnectMaxMs: () => snapshot().settings.echo.reconnectMaxMs,
      pingIntervalMs: () => snapshot().settings.echo.pingIntervalMs,
      pingTimeoutMs: () => snapshot().settings.echo.pingTimeoutMs,
      timezone: () => posixTimezone(snapshot().settings.assistant.timeZone),
    });
    const pipeline = new VoicePipeline({
      client,
      services,
      turns,
      replies,
      config,
      settings: snapshot,
      sessions,
      deviceId: device.id,
      // Only what the prompt needs: the row (and its key) never reaches the agent.
      device: () => {
        const current = this.runtimes.get(device.id)?.device ?? device;
        return { name: current.name, prompt: current.prompt };
      },
      // Without REPLY_AUDIO_BASE_URL: this machine as the Echo's connection sees it.
      fallbackReplyBaseUrl: () => `http://${client.localAddress ?? '127.0.0.1'}:${env.PORT}`,
      tools,
    });
    const runtime: DeviceRuntime = { device, client, pipeline, reportedNodeName: null };

    client.on('device-info', (info) => this.onDeviceInfo(device.id, info));
    client.on('connected', () => this.recomputeDuplicateNames());
    client.on('disconnected', () => this.recomputeDuplicateNames());
    return runtime;
  }

  private async startRuntime(runtime: DeviceRuntime): Promise<void> {
    if (!runtime.device.enabled) return;
    runtime.client.start();
  }

  private async stopRuntime(runtime: DeviceRuntime): Promise<void> {
    runtime.pipeline.stop();
    await runtime.client.stop();
  }

  /** First connect stores the node name; a different one means another Echo is at that address. */
  private onDeviceInfo(deviceId: number, info: DeviceInfo): void {
    const runtime = this.runtimes.get(deviceId);
    if (!runtime) return;
    runtime.reportedNodeName = info.name;
    const known = runtime.device.nodeName;
    if (!known) {
      const updated = this.options.repository.setNodeName(deviceId, info.name);
      if (updated) runtime.device = updated;
      log.info(`device "${runtime.device.name}" is "${info.name}" (node name learned)`);
    } else if (known !== info.name) {
      log.error(
        `device "${runtime.device.name}" was accepted as "${known}" but reports "${info.name}": closing the link ` +
          '(accept the new device if this is expected)',
      );
      this.problems.set(deviceId, 'unexpected-device');
      void runtime.client.stop();
    }
    this.recomputeDuplicateNames();
  }

  /**
   * Two connected Echos with the same node name break hassmic's Echo network
   * (arbitration cannot tell them apart), so both show the problem.
   */
  private recomputeDuplicateNames(): void {
    const byName = new Map<string, number[]>();
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.client.isConnected) continue;
      const name = runtime.device.nodeName;
      if (!name) continue;
      const ids = byName.get(name) ?? [];
      ids.push(id);
      byName.set(name, ids);
    }
    for (const [id] of this.runtimes) {
      if (this.problems.get(id) === 'duplicate-node-name') this.problems.delete(id);
    }
    for (const ids of byName.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (this.problems.get(id) === 'unexpected-device') continue;
        this.problems.set(id, 'duplicate-node-name');
      }
    }
  }
}
