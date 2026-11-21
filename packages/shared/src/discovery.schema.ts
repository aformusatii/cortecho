import { z } from 'zod';

/**
 * Discovery of Echos on the local network (spec §6). The result lives in
 * memory only: it is rebuilt after a restart, from mDNS and the subnet scan.
 */

/** Where a sighting came from: the live mDNS browse, the subnet scan, or both. */
export const DISCOVERY_SOURCES = ['mdns', 'scan', 'both'] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/** `set` = the Echo has a key (its own, or a key we do not know). */
export const DISCOVERY_KEY_STATES = ['none', 'set'] as const;
export type DiscoveredKeyState = (typeof DISCOVERY_KEY_STATES)[number];

/** One Echo found on the network (spec §6.2), as the UI sees it. */
export type DiscoveredEcho = {
  /** 12 lower-case hex, the identity (spec §1.2 S3). */
  mac: string;
  host: string;
  port: number;
  /** hassmic's NAME / the mDNS service instance name. */
  nodeName: string;
  friendlyName: string;
  model: string | null;
  keyState: DiscoveredKeyState;
  source: DiscoverySource;
  lastSeenAt: string;
  /** Matched by MAC first, then by host:port (rows from before the MAC column). */
  addedAs: { id: number; name: string } | null;
  /** §7.7: the same MAC is seen at another address while the device is not connected. */
  movedFrom: { id: number; name: string; host: string } | null;
  ignored: boolean;
};

/** GET /api/discovery and the 202 body of POST /api/discovery/scan. */
export type DiscoveryDocument = {
  scanning: boolean;
  lastScanAt: string | null;
  found: DiscoveredEcho[];
};

/** Plain 12 hex or colon-separated; the route stores the plain form. */
export const discoveryMacSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})$/,
    "Enter the Echo's MAC address (12 hex digits).",
  );

/** POST /api/discovery/scan: the UI sends its own location.hostname as a hint. */
export const discoveryScanSchema = z.object({
  hints: z.array(z.string().trim().min(1).max(253)).max(8).optional(),
});
export type DiscoveryScan = z.infer<typeof discoveryScanSchema>;

/** POST /api/discovery/ignore. */
export const discoveryIgnoreSchema = z.object({ mac: discoveryMacSchema });
export type DiscoveryIgnore = z.infer<typeof discoveryIgnoreSchema>;
