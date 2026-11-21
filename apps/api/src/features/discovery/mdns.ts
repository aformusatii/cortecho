import { isPrivateIpv4 } from '@cortecho/shared';
import Bonjour from 'bonjour-service';
import { normalizeMac } from '../../esphome/mac.ts';

/**
 * mDNS browse of `_esphomelib._tcp` (spec §6.1.1), kept behind a tiny
 * interface so tests and a container without multicast never touch the socket.
 *
 * hassmic announces the service from `print_mdns_to` (proto_esphome.c):
 * the service instance name is the node name, the port is the API port, and
 * the TXT records are mac (12 hex), friendly_name, version, platform=hassmic,
 * network=wifi, plus exactly one of `api_encryption` (a key is set) or
 * `api_encryption_supported` (no key yet).
 */

export type ParsedMdnsTxt = {
  mac: string;
  friendlyName: string;
  keyState: 'none' | 'set';
  platform: string | null;
};

/** What a browser tells the service: a hassmic service on a private IPv4. */
export type MdnsSighting = {
  /** The service instance name = hassmic's node name. */
  name: string;
  host: string;
  port: number;
  mac: string;
  friendlyName: string;
  keyState: 'none' | 'set';
};

/** Injectable: `null` in tests and whenever a socket must not be opened. */
export type MdnsBrowser = {
  start(onSighting: (sighting: MdnsSighting) => void, onError: (error: unknown) => void): void;
  stop(): void;
};

/**
 * Pure TXT parser. Returns null for no/invalid MAC, or for an explicitly
 * foreign platform: the LAN may have other ESPHome boards, and only hassmic
 * offers the voice assistant.
 */
export function parseMdnsTxt(txt: Record<string, unknown>): ParsedMdnsTxt | null {
  const mac = normalizeMac(text(txt.mac) ?? '');
  if (!mac) return null;
  // Only hassmic offers the voice assistant; other ESPHome boards on the LAN
  // announce `_esphomelib._tcp` too, with another (or no) platform.
  const platform = text(txt.platform);
  if (platform?.toLowerCase() !== 'hassmic') return null;
  // With a key, hassmic prints api_encryption; without, api_encryption_supported.
  const keyState = text(txt.api_encryption) !== null ? 'set' : 'none';
  return { mac, friendlyName: text(txt.friendly_name) ?? '', keyState, platform };
}

/** Maps one browse result: valid hassmic TXT plus the first private IPv4 address. */
export function sightingFromService(service: {
  name: string;
  port: number;
  addresses?: string[];
  txt?: unknown;
}): MdnsSighting | null {
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65_535) return null;
  const parsed = parseMdnsTxt(textRecord(service.txt));
  if (!parsed) return null;
  const host = (service.addresses ?? []).find(isPrivateIpv4);
  if (!host) return null;
  return {
    name: service.name,
    host,
    port: service.port,
    mac: parsed.mac,
    friendlyName: parsed.friendlyName,
    keyState: parsed.keyState,
  };
}

/** The real browser: one Bonjour instance, `_esphomelib._tcp`, `up` events only. */
export function createBonjourBrowser(): MdnsBrowser {
  let bonjour: InstanceType<typeof Bonjour> | null = null;
  let browser: { stop: () => void } | null = null;
  return {
    start(onSighting, onError) {
      try {
        // The error callback is the library's hook for socket/decoder errors
        // (README: "highly recommended"); without it, they can crash the process.
        bonjour = new Bonjour(undefined, (error: unknown) => onError(error));
        const found = bonjour.find({ type: 'esphomelib' });
        found.on('up', (service) => {
          const sighting = sightingFromService(service);
          if (sighting) onSighting(sighting);
        });
        browser = found;
      } catch (error) {
        onError(error);
      }
    },
    stop() {
      try {
        browser?.stop();
        bonjour?.destroy();
      } catch {
        // Already down, or never started: shutdown must not throw.
      }
      browser = null;
      bonjour = null;
    },
  };
}

/** TXT values arrive as string or Buffer; anything else is not a TXT value. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

/** bonjour-service hands `txt` as an object of string|Buffer values. */
function textRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
