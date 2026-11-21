/**
 * The local-network address rule shared by device validation, the reply
 * address setting and the doctor. The gateway must never be made to reach the
 * internet: only RFC 1918 addresses and loopback are allowed (loopback keeps a
 * FakeEcho / `npm run dev` flow working).
 */

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
