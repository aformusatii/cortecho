import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Host validation for devices (spec §10.3). The gateway must never be made to
 * connect to the internet: only RFC 1918 addresses and loopback are allowed
 * (loopback keeps a FakeEcho `npm run fake-echo` flow working). Checked at
 * create/update and again before each connect; the manager connects to the
 * resolved literal, so a name is not re-resolved behind our back.
 */
export type HostCheck = { ok: true } | { ok: false; message: string };

/** True for 10/8, 172.16/12, 192.168/16 and 127/8. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

/** Checks a literal IP or a name; every address a name resolves to must be allowed. */
export async function checkHost(host: string): Promise<HostCheck> {
  const value = host.trim();
  if (value === '') return { ok: false, message: 'Enter an address.' };
  if (net.isIPv6(value))
    return { ok: false, message: 'Use an IPv4 address or a host name; IPv6 is not supported.' };
  if (net.isIPv4(value)) return literalCheck(value);

  try {
    const addresses = await lookup(value, { family: 4, all: true });
    if (addresses.length === 0)
      return { ok: false, message: 'This name does not resolve to an IPv4 address.' };
    const bad = addresses.find((entry) => !isPrivateIpv4(entry.address));
    if (bad) return { ok: false, message: publicMessage(value, bad.address) };
    return { ok: true };
  } catch {
    return { ok: false, message: `This name does not resolve (${value}).` };
  }
}

/** The literal to connect to: the IP itself, or the first private address a name resolves to. */
export async function resolveHost(host: string): Promise<string | null> {
  const value = host.trim();
  if (net.isIPv4(value)) return isPrivateIpv4(value) ? value : null;
  if (net.isIPv6(value) || value === '') return null;
  try {
    const addresses = await lookup(value, { family: 4, all: true });
    if (addresses.length === 0) return null;
    if (addresses.some((entry) => !isPrivateIpv4(entry.address))) return null;
    return addresses[0]?.address ?? null;
  } catch {
    return null;
  }
}

function literalCheck(address: string): HostCheck {
  if (isPrivateIpv4(address)) return { ok: true };
  const [a, b] = address.split('.').map(Number) as [number, number, number, number];
  if (a === 169 && b === 254)
    return { ok: false, message: 'Link-local addresses (169.254.x.x) are not allowed.' };
  if (a === 0) return { ok: false, message: '0.0.0.0 is not a device address.' };
  if (a >= 224) return { ok: false, message: 'Multicast and reserved addresses are not allowed.' };
  return { ok: false, message: publicMessage(address, address) };
}

function publicMessage(host: string, address: string): string {
  return `${host} (${address}) is not on the local network. Use a 10.x, 172.16-31.x, 192.168.x or 127.x address.`;
}
