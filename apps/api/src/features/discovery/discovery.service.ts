import type {
  DeviceStatus,
  DiscoveredEcho,
  DiscoveredKeyState,
  DiscoveryDocument,
  DiscoverySource,
} from '@cortecho/shared';
import { type ProbeOptions, probeEcho } from '../../esphome/adopt.ts';
import { createLogger, errorMessage, type Logger } from '../../lib/logger.ts';
import type { Device } from '../devices/devices.repository.ts';
import { resolveHost } from '../devices/host.ts';
import type { DiscoveryRepository } from './discovery.repository.ts';
import type { MdnsBrowser, MdnsSighting } from './mdns.ts';
import {
  type DiscoveryTarget,
  expandTargets,
  mapLimit,
  SCAN_CONNECT_TIMEOUT_MS,
  SCAN_CONNECTS_IN_FLIGHT,
  SCAN_PROBE_TIMEOUT_MS,
  SCAN_PROBES_IN_FLIGHT,
  tcpConnect,
} from './subnet.ts';

/** What discovery needs from the manager; a subset, so tests can stub it. */
export type DiscoveryDevices = {
  listDevices(): Device[];
  status(device: Device): DeviceStatus;
};

export type DiscoveryServiceOptions = {
  devices: DiscoveryDevices;
  repository: DiscoveryRepository;
  /** `DISCOVERY_EXTRA_TARGETS` from config (other subnets, tests). */
  extraTargets: readonly DiscoveryTarget[];
  /** The `network.replyBaseUrl` setting: its host is a scan hint. */
  replyBaseUrl: () => string;
  /** null = no mDNS (tests, or deliberately off). */
  mdns?: MdnsBrowser | null;
  /** Injectable for unit tests; defaults to the real probe. */
  probe?: typeof probeEcho;
  /** Injectable clock (ms since epoch); defaults to Date.now. */
  now?: () => number;
  /** Sightings unseen for this long drop out (spec §6.2: 30 min). */
  entryTtlMs?: number;
  /** At most one scan per interval (spec §6.1.2: 60 s). */
  scanIntervalMs?: number;
  /** Scan tuning; tests shorten the connect timeout. */
  connect?: typeof tcpConnect;
  connectTimeoutMs?: number;
  connectInFlight?: number;
  probeTimeoutMs?: number;
  log?: Logger;
};

/** One in-memory sighting; `addedAs`, `movedFrom` and `ignored` are derived on read. */
type Sighting = {
  mac: string;
  host: string;
  port: number;
  nodeName: string;
  friendlyName: string;
  model: string | null;
  keyState: DiscoveredKeyState;
  /** `both` when mDNS and the scan have both seen this MAC. */
  source: DiscoverySource;
  lastSeenAtMs: number;
};

const DEFAULT_ENTRY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;

/**
 * Finds Echos on the network (spec §6): a continuous mDNS browse plus an
 * on-demand subnet probe. Results are memory only and rebuilt after a restart.
 *
 * Nothing here may take the process down: a scan that fails is logged, and an
 * mDNS socket that cannot be opened (Docker's bridge network has no multicast)
 * is a warning, not an error.
 */
export class DiscoveryService {
  private readonly options: DiscoveryServiceOptions;
  private readonly log: Logger;
  private readonly probe: typeof probeEcho;
  private readonly connect: typeof tcpConnect;
  private readonly now: () => number;
  private readonly entryTtlMs: number;
  private readonly scanIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly connectInFlight: number;
  private readonly probeTimeoutMs: number;
  private readonly sightings = new Map<string, Sighting>();
  private readonly abort = new AbortController();
  private scanning = false;
  private lastScanAt: string | null = null;
  private lastScanStartedAtMs: number | null = null;
  private currentScan: Promise<void> | null = null;
  private started = false;
  private mdnsWarned = false;

  constructor(options: DiscoveryServiceOptions) {
    this.options = options;
    this.log = options.log ?? createLogger('discovery');
    this.probe = options.probe ?? probeEcho;
    this.connect = options.connect ?? tcpConnect;
    this.now = options.now ?? Date.now;
    this.entryTtlMs = options.entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? SCAN_CONNECT_TIMEOUT_MS;
    this.connectInFlight = options.connectInFlight ?? SCAN_CONNECTS_IN_FLIGHT;
    this.probeTimeoutMs = options.probeTimeoutMs ?? SCAN_PROBE_TIMEOUT_MS;
  }

  /**
   * Called once at server start: opens the mDNS browse and, when there is any
   * hint to work from, asks for one scan. Returns immediately; the scan runs in
   * the background so startup never depends on the network.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.options.mdns) {
      try {
        this.options.mdns.start(
          (sighting) => this.onMdnsSighting(sighting),
          (error) => this.onMdnsError(error),
        );
      } catch (error) {
        this.onMdnsError(error);
      }
    }
    if (this.hasHints()) this.startScan();
  }

  stop(): void {
    this.started = false;
    this.abort.abort();
    try {
      this.options.mdns?.stop();
    } catch {
      // Shutdown must not throw.
    }
  }

  /** The current document; prunes entries not seen for the TTL. */
  document(): DiscoveryDocument {
    this.pruneExpired();
    const devices = this.options.devices.listDevices();
    const ignored = this.options.repository.ignoredMacs();
    const found = [...this.sightings.values()]
      .map((sighting) => this.toDiscoveredEcho(sighting, devices, ignored))
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName) || a.mac.localeCompare(b.mac));
    return { scanning: this.scanning, lastScanAt: this.lastScanAt, found };
  }

  /**
   * Asks for a scan (spec §6.1.2). The work starts in the background; this
   * returns the current document at once, so the HTTP route can answer 202.
   * A scan that is running, or one started less than `scanIntervalMs` ago, is
   * not repeated.
   */
  startScan(hints: readonly string[] = []): DiscoveryDocument {
    const now = this.now();
    const allowed =
      !this.scanning &&
      (this.lastScanStartedAtMs === null || now - this.lastScanStartedAtMs >= this.scanIntervalMs);
    if (allowed) {
      this.scanning = true;
      this.lastScanStartedAtMs = now;
      this.currentScan = this.runScan(hints)
        .catch((error) => this.log.warn(`discovery: scan failed (${errorMessage(error)})`))
        .finally(() => {
          this.scanning = false;
          this.currentScan = null;
          this.lastScanAt = new Date(this.now()).toISOString();
        });
    }
    return this.document();
  }

  /** Resolves when the running scan (if any) has finished; for tests and shutdown. */
  whenIdle(): Promise<void> {
    return this.currentScan ?? Promise.resolve();
  }

  ignore(mac: string): void {
    this.options.repository.ignore(mac);
  }

  unignore(mac: string): void {
    this.options.repository.unignore(mac);
  }

  // -------------------------------------------------------------------------

  private async runScan(hints: readonly string[]): Promise<void> {
    const before = new Set(this.sightings.keys());
    const targets = await this.scanTargets(hints);
    const open = (
      await mapLimit(targets, this.connectInFlight, async (target) =>
        (await this.connect(target.host, target.port, this.connectTimeoutMs)) ? target : null,
      )
    ).filter((target): target is DiscoveryTarget => target !== null);

    const probes = await mapLimit(open, SCAN_PROBES_IN_FLIGHT, async (target) => ({
      target,
      result: await this.probe(this.probeOptions(target)),
    }));

    for (const { target, result } of probes) {
      if (!result.reachable) continue;
      // Only an Echo voice device, or one that reports a key (which hides the
      // feature flags until the key is known: the "already secured" case).
      if (result.isVoiceAssistant !== true && result.keyState !== 'set') continue;
      if (!result.mac) {
        this.log.debug(`discovery: ${target.host}:${target.port} answered without a MAC, skipped`);
        continue;
      }
      this.record({
        mac: result.mac,
        host: target.host,
        port: target.port,
        nodeName: result.nodeName ?? '',
        friendlyName: result.friendlyName || result.nodeName || target.host,
        model: result.model,
        keyState: result.keyState === 'none' ? 'none' : 'set',
        source: 'scan',
      });
    }

    const newCount = [...this.sightings.keys()].filter((mac) => !before.has(mac)).length;
    this.log.info(`discovery: found ${this.liveCount()} Echos (${newCount} new)`);
  }

  private async scanTargets(hints: readonly string[]): Promise<DiscoveryTarget[]> {
    const devices = this.options.devices.listDevices();
    const allHints = [
      ...hints,
      ...devices.map((device) => device.host),
      hostOfUrl(this.options.replyBaseUrl()),
    ];
    const targets = await expandTargets({
      hints: allHints,
      extraTargets: this.options.extraTargets,
      resolve: resolveHost,
    });
    // Never probe an Echo we serve: its link already tells us everything, and
    // hassmic gives the voice assistant to one subscriber only.
    const owned = new Set(
      devices.filter((device) => device.enabled).map((device) => `${device.host.trim()}:${device.port}`),
    );
    return targets.filter((target) => !owned.has(`${target.host}:${target.port}`));
  }

  private probeOptions(target: DiscoveryTarget): ProbeOptions {
    return {
      host: target.host,
      port: target.port,
      clientInfo: 'cortecho-discovery',
      timeoutMs: this.probeTimeoutMs,
      signal: this.abort.signal,
    };
  }

  private onMdnsSighting(sighting: MdnsSighting): void {
    const isNew = !this.sightings.has(sighting.mac);
    this.record({
      mac: sighting.mac,
      host: sighting.host,
      port: sighting.port,
      nodeName: sighting.name,
      friendlyName: sighting.friendlyName || sighting.name,
      model: null,
      keyState: sighting.keyState,
      source: 'mdns',
    });
    if (isNew) this.log.info(`discovery: found ${this.liveCount()} Echos (1 new)`);
  }

  private onMdnsError(error: unknown): void {
    // Multicast often does not reach a bridged container. Say it once, then
    // stay quiet; the subnet scan still finds the Echos.
    if (!this.mdnsWarned) {
      this.mdnsWarned = true;
      this.log.warn(`discovery: mDNS is unavailable; the network scan still works (${errorMessage(error)})`);
      return;
    }
    this.log.debug(`discovery: mDNS error (${errorMessage(error)})`);
  }

  private record(input: Omit<Sighting, 'source' | 'lastSeenAtMs'> & { source: 'mdns' | 'scan' }): void {
    const prior = this.sightings.get(input.mac);
    const source: DiscoverySource = prior && prior.source !== input.source ? 'both' : input.source;
    this.sightings.set(input.mac, { ...input, source, lastSeenAtMs: this.now() });
  }

  private toDiscoveredEcho(sighting: Sighting, devices: Device[], ignored: Set<string>): DiscoveredEcho {
    const byMac = devices.find((device) => device.mac === sighting.mac) ?? null;
    const owner =
      byMac ??
      devices.find((device) => device.host === sighting.host && device.port === sighting.port) ??
      null;

    let movedFrom: DiscoveredEcho['movedFrom'] = null;
    if (
      byMac?.enabled &&
      (byMac.host !== sighting.host || byMac.port !== sighting.port) &&
      this.options.devices.status(byMac).state !== 'connected'
    ) {
      movedFrom = { id: byMac.id, name: byMac.name, host: byMac.host };
    }

    const source: DiscoverySource = sighting.source;
    return {
      mac: sighting.mac,
      host: sighting.host,
      port: sighting.port,
      nodeName: sighting.nodeName,
      friendlyName: sighting.friendlyName,
      model: sighting.model,
      keyState: sighting.keyState,
      source,
      lastSeenAt: new Date(sighting.lastSeenAtMs).toISOString(),
      addedAs: owner ? { id: owner.id, name: owner.name } : null,
      movedFrom,
      ignored: ignored.has(sighting.mac),
    };
  }

  private hasHints(): boolean {
    return (
      this.options.devices.listDevices().length > 0 ||
      this.options.replyBaseUrl().trim() !== '' ||
      this.options.extraTargets.length > 0
    );
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [mac, sighting] of this.sightings) {
      if (now - sighting.lastSeenAtMs > this.entryTtlMs) this.sightings.delete(mac);
    }
  }

  private liveCount(): number {
    this.pruneExpired();
    return this.sightings.size;
  }
}

/** The reply address as a scan hint: its host name, or the value as written. */
function hostOfUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed).hostname;
  } catch {
    return trimmed;
  }
}
