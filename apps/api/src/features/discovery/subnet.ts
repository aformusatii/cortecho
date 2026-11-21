import net from 'node:net';
import { isPrivateIpv4 } from '@cortecho/shared';
import { resolveHost } from '../devices/host.ts';

/**
 * The subnet half of discovery (spec §6.1.2): a short TCP connect on the API
 * port of every address in the /24s around the hints, then a full probe of
 * each open port. Pure helpers plus a connection function, so the shape is
 * unit-testable without an Echo.
 */

export type DiscoveryTarget = { host: string; port: number };

export const ECHO_API_PORT = 26053;
/** A LAN Echo answers a TCP connect at once; 400 ms is generous. */
export const SCAN_CONNECT_TIMEOUT_MS = 400;
export const SCAN_CONNECTS_IN_FLIGHT = 64;
export const SCAN_PROBES_IN_FLIGHT = 8;
export const SCAN_PROBE_TIMEOUT_MS = 4_000;

/** The 254 usable addresses of an IPv4 /24, or null for a non-IPv4 value. */
export function subnet24(address: string): string[] | null {
  if (!net.isIPv4(address)) return null;
  const [a, b, c] = address.split('.') as [string, string, string, string];
  const base = `${a}.${b}.${c}`;
  const addresses: string[] = [];
  for (let last = 1; last <= 254; last += 1) addresses.push(`${base}.${last}`);
  return addresses;
}

/** Runs `fn` over `items` with at most `limit` promises outstanding (order preserved). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** TCP connect only; true on `connect`, false on error or timeout. */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    function finish(connected: boolean): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Expands hints into scan targets:
 * - a private IPv4 hint → its whole /24 on port 26053;
 * - a host name hint → resolve it (private IPv4 only) → its /24;
 * - a URL hint (the reply address) → its host name, then the rule above;
 * - each extra target → its own address and port.
 * Public, link-local, malformed and IPv6 values are dropped. Deduplicated.
 */
export async function expandTargets(input: {
  hints: readonly string[];
  extraTargets: readonly DiscoveryTarget[];
  resolve?: (host: string) => Promise<string | null>;
}): Promise<DiscoveryTarget[]> {
  const resolve = input.resolve ?? resolveHost;
  const targets = new Map<string, DiscoveryTarget>();
  const add = (host: string, port: number): void => {
    if (!isPrivateIpv4(host)) return;
    targets.set(`${host}:${port}`, { host, port });
  };

  const hosts = [...new Set(input.hints.map(hostOf).filter(Boolean))];
  const subnets = await Promise.all(
    hosts.map(async (host) => {
      const address = net.isIPv4(host) ? host : await resolve(host);
      if (!address || !isPrivateIpv4(address)) return null;
      return subnet24(address);
    }),
  );
  for (const subnet of subnets) {
    if (!subnet) continue;
    for (const host of subnet) add(host, ECHO_API_PORT);
  }

  await Promise.all(
    input.extraTargets.map(async (target) => {
      const host = target.host.trim();
      if (host === '' || net.isIPv6(host)) return;
      const address = net.isIPv4(host) ? host : await resolve(host);
      if (address) add(address, target.port);
    }),
  );

  return [...targets.values()];
}

/** A hint is a host, a host name, or a URL; only its host part is used. */
function hostOf(hint: string): string {
  const value = hint.trim();
  if (value === '') return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }
  return value;
}
