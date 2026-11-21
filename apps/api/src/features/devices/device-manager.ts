import { randomBytes } from 'node:crypto';
import type {
  ApiErrorCode,
  DeviceKind,
  DeviceStatus,
  EchoProbeFailure,
  EchoProbeResult,
  EchoProblem,
} from '@cortecho/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Config } from '../../config.ts';
import { env, isProduction } from '../../env.ts';
import { probeEcho, setKeyOnUnkeyedEcho } from '../../esphome/adopt.ts';
import { EsphomeClient } from '../../esphome/client.ts';
import { normalizeMac } from '../../esphome/mac.ts';
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
import { type Device, type DevicesRepository, DuplicateDeviceError } from './devices.repository.ts';
import { checkHost, resolveHost } from './host.ts';

const log = createLogger('devices');

/** How long adoption/secure wait for the encrypted link before returning the status anyway. */
const ADOPT_LINK_TIMEOUT_MS = 10_000;

/** One Echo's live pieces. `device` is replaced on rename/prompt edits, so read it per use. */
export type DeviceRuntime = {
  device: Device;
  client: EsphomeClient;
  pipeline: VoicePipeline;
  /** The node name the Echo reported at its last connect (for "accept new device"). */
  reportedNodeName: string | null;
  /** The MAC the Echo reported at its last connect (accepted together with the node name). */
  reportedMac: string | null;
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
  /**
   * Whether this process runs as the deployed app (Docker / NODE_ENV=production).
   * Missing = the current environment; tests inject it.
   */
  production?: boolean;
  /** How long adoption/secure wait for the encrypted link before returning the status anyway. */
  linkTimeoutMs?: number;
};

/** POST /api/devices/:id/accept-device without a reported name. */
export class NoReportedDeviceError extends Error {
  constructor() {
    super('This Echo has not reported a node name yet.');
    this.name = 'NoReportedDeviceError';
  }
}

/**
 * A probe, adoption or "secure now" ended without a device. The routes turn it
 * into the standard `{ error: { code, message, fields? } }` body; the codes are
 * the ones in spec §7.3/§7.4.
 */
export class DeviceSetupError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string> | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DeviceSetupError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export type ProbeInput = {
  host: string;
  port: number;
  /** Base64, to check a pasted key against an Echo someone else secured. */
  apiKey?: string | null;
};

export type AdoptInput = {
  host: string;
  port: number;
  name?: string;
  kind: DeviceKind;
  /** Only for an Echo that already has a key: use this one instead of SetKey. */
  apiKey?: string | null;
};

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
  /**
   * `host:port` of an adoption or "secure now" in flight. One at a time, so two
   * clicks can never open two connections to one Echo (spec §7.4).
   */
  private readonly setups = new Set<string>();
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

  /** "Accept new device": stores the node name (and MAC) the Echo reported and reconnects. */
  async acceptDevice(deviceId: number): Promise<Device> {
    const runtime = this.runtimes.get(deviceId);
    const reported = runtime?.reportedNodeName ?? null;
    if (!reported) throw new NoReportedDeviceError();
    let updated = this.options.repository.setNodeName(deviceId, reported);
    if (!updated) throw new Error('No such device.');
    const reportedMac = runtime?.reportedMac ?? null;
    if (reportedMac) {
      try {
        updated = this.options.repository.setMac(deviceId, reportedMac) ?? updated;
      } catch (error) {
        if (!(error instanceof DuplicateDeviceError)) throw error;
        throw new DeviceSetupError(
          409,
          'CONFLICT',
          'Another Echo already has this MAC address. Delete the other one first.',
        );
      }
      if (runtime) runtime.device = updated;
    }
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
      mac: device.mac,
      hasKey: device.apiKey !== null,
      state: device.enabled ? (client?.state ?? 'disconnected') : 'disabled',
      encryption: device.apiKey ? 'noise' : 'plaintext',
      problem: this.problems.get(device.id) ?? client?.problem ?? this.replyAddressProblem(device),
      connectedSince: client?.connectedSince?.toISOString() ?? null,
      lastPongAt: client?.lastPongAt?.toISOString() ?? null,
      reconnects: client?.reconnects ?? 0,
      lastTimeSyncAt: client?.lastTimeSyncAt?.toISOString() ?? null,
      info: client?.echoInfo ?? null,
      pipeline: { state: runtime?.pipeline.state ?? 'idle' },
      hasSession: device.enabled ? this.options.sessions.has(`device:${device.id}`) : false,
      overrideCount: Object.keys(device.overrides).length,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * What answers at this address (spec §7.3). Refuses an enabled device's
   * address: its own link already tells us everything, and we never open a
   * second connection to an Echo we serve.
   */
  async probe(input: ProbeInput): Promise<EchoProbeResult> {
    const host = input.host.trim();
    const setupKey = listenKey(host, input.port);
    if (this.setups.has(setupKey)) {
      throw new DeviceSetupError(409, 'CONFLICT', 'This Echo is already being added.');
    }
    await this.assertHostAllowed(host);
    const owner = this.options.repository.findByHostPort(host, input.port);
    if (owner?.enabled) throw this.alreadyAddedError(owner);
    return probeEcho({
      host,
      port: input.port,
      apiKey: input.apiKey ?? null,
      clientInfo: 'cortecho-setup',
    });
  }

  /**
   * Adds an Echo (spec §7.4). The key is generated here, stored on a disabled
   * row **before** SetKey is sent, and never logged or returned.
   */
  async adopt(input: AdoptInput): Promise<Device> {
    const host = input.host.trim();
    const setupKey = listenKey(host, input.port);
    this.beginSetup(setupKey);
    let createdId: number | null = null;
    /** Set once the Echo may hold our key: from then on the row must survive every failure. */
    let keepRow = false;
    try {
      await this.assertHostAllowed(host);
      const existing = this.options.repository.findByHostPort(host, input.port);
      if (existing) throw this.alreadyAddedError(existing);

      const probe = await probeEcho({ host, port: input.port, clientInfo: 'cortecho-setup' });
      if (!probe.reachable) throw probeFailure(probe, host, input.port);
      if (probe.isVoiceAssistant === false) throw notAnEchoError(host, input.port);
      if (probe.mac) {
        const byMac = this.options.repository.findByMac(probe.mac);
        if (byMac) throw this.alreadyAddedError(byMac);
      }

      let keyText: string;
      let storeKey: boolean;
      if (probe.keyState === 'none') {
        keyText = randomBytes(32).toString('base64');
        storeKey = true;
      } else {
        // Someone else (often Home Assistant) already secured this Echo.
        if (!input.apiKey) throw keySetError();
        try {
          parseApiKey(input.apiKey);
        } catch {
          throw keyInvalidError();
        }
        const keyed = await probeEcho({
          host,
          port: input.port,
          apiKey: input.apiKey,
          clientInfo: 'cortecho-setup',
        });
        if (!keyed.reachable || keyed.keyState !== 'matches') throw keyInvalidError();
        keyText = input.apiKey.trim();
        storeKey = false;
      }

      const baseName = input.name ?? probe.friendlyName ?? probe.nodeName ?? `Echo ${host}`;
      const created = this.createRow({
        name: baseName,
        kind: input.kind,
        host,
        port: input.port,
        apiKey: keyText,
        nodeName: probe.nodeName,
        mac: probe.mac,
      });
      createdId = created.id;

      let outcome: 'secured' | 'unverified' = 'secured';
      if (storeKey) outcome = await this.setKeyWithRecovery(host, input.port, keyText);
      keepRow = true;
      if (outcome === 'unverified') {
        log.warn(`device ${created.id}: adoption answer lost, keeping the key`);
      }

      const enabled = this.options.repository.update(created.id, {
        name: created.name,
        kind: created.kind,
        host: created.host,
        port: created.port,
        apiKey: created.apiKey,
        enabled: true,
        prompt: created.prompt,
      });
      if (!enabled) throw new Error('The device row disappeared during adoption.');
      await this.add(enabled);
      const connected = await this.waitForLink(
        enabled.id,
        this.options.linkTimeoutMs ?? ADOPT_LINK_TIMEOUT_MS,
      );
      log.info(
        `device ${enabled.id} adopted (mac ${enabled.mac ?? 'unknown'}, ${connected ? 'secured' : 'not connected yet'})`,
      );
      return this.device(enabled.id) ?? enabled;
    } catch (error) {
      // Deleting is only safe when the Echo provably does not hold our key.
      if (createdId !== null && !keepRow) this.options.repository.remove(createdId);
      throw error;
    } finally {
      this.setups.delete(setupKey);
    }
  }

  /**
   * "Secure now" for an existing unkeyed row (spec §7.4): the same key steps,
   * with the row's runtime stopped so no second connection ever opens.
   */
  async secure(deviceId: number): Promise<Device> {
    const before = this.device(deviceId);
    if (!before) throw new DeviceSetupError(404, 'NOT_FOUND', `No device #${deviceId}.`);
    if (before.apiKey !== null) {
      throw new DeviceSetupError(409, 'ECHO_KEY_SET', 'This Echo already has a key in Cortecho.');
    }
    const setupKey = listenKey(before.host, before.port);
    this.beginSetup(setupKey);
    /** Set once the Echo may hold our key: from then on the row's key is never reverted. */
    let keepRow = false;
    try {
      await this.assertHostAllowed(before.host);
      const runtime = this.runtimes.get(deviceId);
      // A running turn is aborted: SetKey needs the Echo to itself, like a probe.
      if (runtime) {
        await this.stopRuntime(runtime);
        // Let the Echo process the closed link before the probe opens one.
        await new Promise((resolve) => setImmediate(resolve));
      }

      const probe = await probeEcho({
        host: before.host,
        port: before.port,
        apiKey: null,
        clientInfo: 'cortecho-setup',
      });
      if (!probe.reachable) throw probeFailure(probe, before.host, before.port);
      if (probe.isVoiceAssistant === false) throw notAnEchoError(before.host, before.port);
      if (probe.keyState !== 'none') {
        throw new DeviceSetupError(
          409,
          'ECHO_KEY_SET',
          'This Echo is already secured by another app. Paste its key on the Connection tab instead.',
        );
      }
      if (before.mac && probe.mac && before.mac !== probe.mac) {
        throw new DeviceSetupError(
          409,
          'CONFLICT',
          'The device at this address reports a different MAC: it is not the Echo this device was added as.',
        );
      }

      const keyText = randomBytes(32).toString('base64');
      let after = this.options.repository.update(deviceId, {
        name: before.name,
        kind: before.kind,
        host: before.host,
        port: before.port,
        apiKey: keyText,
        enabled: before.enabled,
        prompt: before.prompt,
      });
      if (!after) throw new DeviceSetupError(404, 'NOT_FOUND', `No device #${deviceId}.`);
      if (!before.mac && probe.mac) {
        try {
          after = this.options.repository.setMac(deviceId, probe.mac) ?? after;
        } catch (error) {
          if (error instanceof DuplicateDeviceError) throw this.alreadyAddedErrorForMac();
          throw error;
        }
      }

      const outcome = await this.setKeyWithRecovery(before.host, before.port, keyText);
      keepRow = true;
      if (outcome === 'unverified') {
        log.warn(`device ${deviceId}: secure answer lost, keeping the key`);
      }
      await this.update(before, after);
      await this.waitForLink(deviceId, this.options.linkTimeoutMs ?? ADOPT_LINK_TIMEOUT_MS);
      log.info(`device ${deviceId} secured (mac ${after.mac ?? 'unknown'})`);
      return this.device(deviceId) ?? after;
    } catch (error) {
      // Only undo the key when the Echo provably did not take it.
      if (!keepRow) await this.revertSecure(before);
      throw error;
    } finally {
      this.setups.delete(setupKey);
    }
  }

  // -------------------------------------------------------------------------

  private beginSetup(setupKey: string): void {
    if (this.setups.has(setupKey)) {
      throw new DeviceSetupError(409, 'CONFLICT', 'This Echo is already being added.');
    }
    this.setups.add(setupKey);
  }

  private async assertHostAllowed(host: string): Promise<void> {
    const result = await checkHost(host);
    if (!result.ok) {
      throw new DeviceSetupError(400, 'VALIDATION_ERROR', result.message, { host: result.message });
    }
  }

  private alreadyAddedError(device: Device): DeviceSetupError {
    return new DeviceSetupError(409, 'ALREADY_ADDED', `Already added as ${device.name}.`, {
      deviceId: String(device.id),
      name: device.name,
    });
  }

  private alreadyAddedErrorForMac(): DeviceSetupError {
    return new DeviceSetupError(409, 'ALREADY_ADDED', 'Another Echo already has this MAC address.');
  }

  /**
   * Creates the disabled row, appending " 2", " 3"… to a taken name. The
   * second attempt covers a name taken between the check and the insert.
   */
  private createRow(input: {
    name: string;
    kind: DeviceKind;
    host: string;
    port: number;
    apiKey: string;
    nodeName: string | null;
    mac: string | null;
  }): Device {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return this.options.repository.create({
          name: this.uniqueName(input.name),
          kind: input.kind,
          host: input.host,
          port: input.port,
          apiKey: input.apiKey,
          enabled: false,
          prompt: '',
          nodeName: input.nodeName,
          mac: input.mac,
        });
      } catch (error) {
        if (error instanceof DuplicateDeviceError && error.field === 'name' && attempt === 0) continue;
        if (error instanceof DuplicateDeviceError && error.field !== 'name') {
          const owner =
            error.field === 'mac' && input.mac
              ? this.options.repository.findByMac(input.mac)
              : this.options.repository.findByHostPort(input.host, input.port);
          throw owner
            ? this.alreadyAddedError(owner)
            : new DeviceSetupError(409, 'ALREADY_ADDED', error.message);
        }
        throw error;
      }
    }
    throw new DeviceSetupError(409, 'CONFLICT', 'Could not find an unused name for this Echo.');
  }

  private uniqueName(base: string): string {
    const trimmed = base.trim().slice(0, 80) || 'Echo';
    const names = new Set(this.options.repository.list().map((device) => device.name));
    if (!names.has(trimmed)) return trimmed;
    for (let n = 2; n < 1000; n++) {
      const suffix = ` ${n}`;
      const candidate = `${trimmed.slice(0, 80 - suffix.length)}${suffix}`;
      if (!names.has(candidate)) return candidate;
    }
    return `${trimmed.slice(0, 72)} ${randomBytes(3).toString('hex')}`;
  }

  /**
   * The key was stored before it is sent; the Echo's answer decides whether we
   * can trust that. `'unverified'` means the SetKey was written and the Echo
   * cannot be probed (rebooting): the key is kept, because deleting it could
   * lock the owner out of an Echo that stored it.
   */
  private async setKeyWithRecovery(
    host: string,
    port: number,
    key: string,
  ): Promise<'secured' | 'unverified'> {
    const first = await setKeyOnUnkeyedEcho({ host, port, key, clientInfo: 'cortecho-setup' });
    if (first === 'ok') return 'secured';
    if (first === 'unreachable') {
      throw new DeviceSetupError(
        502,
        'ECHO_UNREACHABLE',
        `Could not reach ${host}:${port}: no key was sent.`,
      );
    }
    if (first === 'refused') {
      // Our key can only be there from a retry: a refused handshake means the
      // SetKey in this call was never written.
      if ((await this.probeKeyState(host, port, key)) === 'matches') return 'secured';
      throw new DeviceSetupError(502, 'ADOPT_FAILED', 'Could not secure the Echo. Nothing was changed.');
    }

    // 'lost': the request reached the Echo; it may or may not have stored it.
    const afterLost = await this.probeKeyState(host, port, key);
    if (afterLost === 'matches') return 'secured';
    if (afterLost === 'unverified') return 'unverified';
    if (afterLost === 'set') throw keySetError();

    // Reachable and still unkeyed: one retry, as spec §7.4 says.
    const retry = await setKeyOnUnkeyedEcho({ host, port, key, clientInfo: 'cortecho-setup' });
    if (retry === 'ok') return 'secured';
    if (retry === 'unreachable') return 'unverified';
    const final = await this.probeKeyState(host, port, key);
    if (final === 'matches') return 'secured';
    if (final === 'unverified') return 'unverified';
    if (final === 'set') throw keySetError();
    throw new DeviceSetupError(502, 'ADOPT_FAILED', 'Could not secure the Echo. Nothing was changed.');
  }

  /** Our key on the Echo? `unverified` = unreachable, so neither answer is safe. */
  private async probeKeyState(
    host: string,
    port: number,
    key: string,
  ): Promise<'matches' | 'none' | 'set' | 'unverified'> {
    const probe = await probeEcho({ host, port, apiKey: key, clientInfo: 'cortecho-setup' });
    if (!probe.reachable) return 'unverified';
    return probe.keyState;
  }

  /** Puts the row back as it was and restarts its (plaintext) link. */
  private async revertSecure(before: Device): Promise<void> {
    try {
      this.options.repository.update(before.id, {
        name: before.name,
        kind: before.kind,
        host: before.host,
        port: before.port,
        apiKey: before.apiKey,
        enabled: before.enabled,
        prompt: before.prompt,
      });
      this.options.repository.setMac(before.id, before.mac);
    } catch (error) {
      log.error(`could not restore device ${before.id} after a failed secure: ${errorMessage(error)}`);
    }
    await this.reconnect(before.id);
  }

  /** Waits for an encrypted link; the caller returns the status even when it is not up yet. */
  private async waitForLink(deviceId: number, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      const runtime = this.runtimes.get(deviceId);
      if (runtime?.client.isConnected && runtime.client.encryption === 'noise') return true;
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
      // Without a reply address setting: this machine as the Echo's connection sees it.
      fallbackReplyBaseUrl: () => `http://${client.localAddress ?? '127.0.0.1'}:${env.PORT}`,
      tools,
    });
    const runtime: DeviceRuntime = {
      device,
      client,
      pipeline,
      reportedNodeName: null,
      reportedMac: null,
    };

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

  /**
   * First connect stores the node name and MAC; either one changing later
   * means another Echo is at that address. A MAC that another row already
   * owns is the same situation (two rows, one Echo).
   */
  private onDeviceInfo(deviceId: number, info: DeviceInfo): void {
    const runtime = this.runtimes.get(deviceId);
    if (!runtime) return;
    runtime.reportedNodeName = info.name;
    runtime.reportedMac = normalizeMac(info.macAddress) ?? runtime.reportedMac;

    const knownName = runtime.device.nodeName;
    const knownMac = runtime.device.mac;
    const reportedMac = runtime.reportedMac;
    const nameMismatch = knownName !== null && knownName !== info.name;
    const macMismatch = knownMac !== null && reportedMac !== null && knownMac !== reportedMac;
    if (nameMismatch || macMismatch) {
      log.error(
        `device "${runtime.device.name}" was accepted as ${knownName ?? 'any name'}` +
          `${knownMac ? ` (${knownMac})` : ''} but reports "${info.name}"` +
          `${reportedMac ? ` (${reportedMac})` : ''}: closing the link ` +
          '(accept the new device if this is expected)',
      );
      this.problems.set(deviceId, 'unexpected-device');
      void runtime.client.stop();
      return;
    }

    let updated = runtime.device;
    if (knownName === null) {
      updated = this.options.repository.setNodeName(deviceId, info.name) ?? updated;
      log.info(`device "${updated.name}" is "${info.name}" (node name learned)`);
    }
    if (knownMac === null && reportedMac !== null) {
      try {
        updated = this.options.repository.setMac(deviceId, reportedMac) ?? updated;
        log.info(`device "${updated.name}" reports MAC ${reportedMac} (learned)`);
      } catch (error) {
        // Another row already has this MAC: two rows for one Echo. Same guard as
        // a changed node name; the owner accepts or deletes one of them.
        log.error(
          `device "${updated.name}" reports MAC ${reportedMac}, which another device already has: closing the link ` +
            `(${errorMessage(error)})`,
        );
        this.problems.set(deviceId, 'unexpected-device');
        void runtime.client.stop();
        return;
      }
    }
    runtime.device = updated;
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

  /**
   * spec §5.4: a production install must tell the Echo a URL it can reach.
   * Without the reply address the link's local address is used, which inside
   * Docker is the container (the Echo hears the wake word and plays nothing).
   * Computed per status call, so saving the setting clears it immediately.
   */
  private replyAddressProblem(device: Device): EchoProblem | null {
    if (!device.enabled || device.kind !== 'echo') return null;
    if (!(this.options.production ?? isProduction)) return null;
    if (this.options.settings.current().settings.network.replyBaseUrl !== '') return null;
    return 'reply-address-missing';
  }
}

/** The in-flight adoption lock's key: one per address and port. */
function listenKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

function probeFailure(probe: EchoProbeFailure, host: string, port: number): DeviceSetupError {
  if (probe.code === 'not-esphome') {
    return new DeviceSetupError(
      409,
      'NOT_AN_ECHO',
      `The device at ${host}:${port} is not an Echo with echo-dot-assist.`,
    );
  }
  return new DeviceSetupError(
    502,
    'ECHO_UNREACHABLE',
    probe.code === 'timeout'
      ? `Nothing answered at ${host}:${port} in time.`
      : `Nothing answered at ${host}:${port}.`,
  );
}

function notAnEchoError(host: string, port: number): DeviceSetupError {
  return new DeviceSetupError(
    409,
    'NOT_AN_ECHO',
    `The device at ${host}:${port} answers, but it does not offer a voice assistant.`,
  );
}

function keySetError(): DeviceSetupError {
  return new DeviceSetupError(
    409,
    'ECHO_KEY_SET',
    'This Echo is already secured. Paste its key, or remove the key on the Echo and try again.',
  );
}

function keyInvalidError(): DeviceSetupError {
  const message = "This is not the Echo's key.";
  return new DeviceSetupError(409, 'ECHO_KEY_INVALID', message, { apiKey: message });
}
