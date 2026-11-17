import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The connector URL policy (SSRF). The URL comes from the UI, so it is checked
 * on save and again on every connect: plain HTTP is only for the LAN (Home
 * Assistant and other self-hosted servers), never for a public host, and DNS is
 * resolved at connect time so rebinding past the save check cannot help.
 *
 * The Echo's own ports are refused everywhere: a connector must never be able
 * to reach the ESPHome API.
 */
export const ECHO_PORTS: ReadonlySet<number> = new Set([26053, 28929, 28931, 16700]);

export type UrlRefusal =
  | 'not-a-url'
  | 'scheme'
  | 'public-http'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'echo-port'
  | 'dns';

export type UrlPolicyResult = { ok: true; url: URL } | { ok: false; reason: UrlRefusal; message: string };

function refuse(reason: UrlRefusal, message: string): UrlPolicyResult {
  return { ok: false, reason, message };
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // handled as link-local below, but private enough to detect
    (a === 100 && b >= 64 && b <= 127) // CGNAT: not public-routable
  );
}

function isIpv4(host: string): boolean {
  return isIP(host) === 4;
}

function isIpv6(host: string): boolean {
  return isIP(host) === 6;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

function isLinkLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIpv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 169 && b === 254;
  }
  return host.startsWith('fe80:') || host.startsWith('fec0:');
}

function isMulticast(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIpv4(host)) {
    const first = Number(host.split('.')[0]);
    return first >= 224 && first <= 239;
  }
  return host.startsWith('ff');
}

function isUnspecified(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '0.0.0.0' || host === '::' || host === '';
}

/** A code check that does not touch the network (used on save). */
export function checkServerUrl(raw: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse('not-a-url', 'Enter a full URL, for example https://example.com/mcp.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refuse('scheme', 'The server URL must be http:// (LAN only) or https://.');
  }
  if (url.username || url.password) {
    return refuse('scheme', 'Do not put credentials in the URL; use the headers or OAuth sign-in.');
  }
  if (ECHO_PORTS.has(Number(url.port))) {
    return refuse('echo-port', 'This port belongs to the Echo API and cannot be used by a connector.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isUnspecified(host)) return refuse('unspecified', 'Use a real host name or address.');
  if (isLinkLocal(host)) {
    return refuse('link-local', 'Link-local and cloud-metadata addresses are not allowed.');
  }
  if (isMulticast(host)) return refuse('multicast', 'Multicast addresses are not allowed.');
  if (url.protocol === 'http:') {
    const local =
      isLoopbackHost(host) ||
      (isIpv4(host) && isPrivateIpv4(host) && !isLinkLocal(host)) ||
      (isIpv6(host) && (host === '::1' || host.startsWith('fc') || host.startsWith('fd')));
    // A host name is resolved at connect time (checkServerUrlResolved); a
    // literal public address is refused right here.
    if (isIP(host) === 4 && !local) {
      return refuse(
        'public-http',
        'Plain HTTP is only allowed for a LAN address (10.x, 172.16–31.x, 192.168.x or loopback). Use https.',
      );
    }
    if (isIP(host) === 6 && !local) {
      return refuse(
        'public-http',
        'Plain HTTP is only allowed for a LAN address (10.x, 172.16–31.x, 192.168.x or loopback). Use https.',
      );
    }
  }
  return { ok: true, url };
}

export type DnsLookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: DnsLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The connect-time check: the same rules, plus every address the name resolves
 * to. A public name that resolves to a LAN or metadata address is refused for
 * plain HTTP; a link-local address is refused for https too.
 */
export async function checkServerUrlResolved(
  raw: string,
  lookup: DnsLookup = defaultLookup,
): Promise<UrlPolicyResult> {
  const code = checkServerUrl(raw);
  if (!code.ok) return code;
  const { url } = code;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return code;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    return refuse('dns', `Could not resolve "${host}".`);
  }
  if (addresses.length === 0) return refuse('dns', `Could not resolve "${host}".`);
  for (const { address } of addresses) {
    if (isLinkLocal(address) || isUnspecified(address) || isMulticast(address)) {
      return refuse('link-local', `"${host}" resolves to a link-local or metadata address.`);
    }
    if (url.protocol === 'http:' && !isPrivateIpv4(address) && !isLoopbackHost(address) && !isIpv6(address)) {
      return refuse('public-http', `"${host}" resolves to a public address; plain HTTP is refused.`);
    }
    if (
      url.protocol === 'http:' &&
      isIpv6(address) &&
      !(address === '::1' || address.startsWith('fc') || address.startsWith('fd'))
    ) {
      return refuse('public-http', `"${host}" resolves to a public address; plain HTTP is refused.`);
    }
  }
  return code;
}

/**
 * Authorization-server endpoints must be HTTPS (loopback HTTP is allowed for
 * local development and tests). Used for metadata/token URLs discovered at
 * runtime, so a malicious MCP server cannot point the token request at
 * `http://` on the LAN.
 */
export function checkAuthorizationServerUrl(raw: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('not-a-url', 'The authorization server URL is not valid.');
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return { ok: true, url };
  return refuse('scheme', 'Authorization server endpoints must use https:// (except loopback).');
}
