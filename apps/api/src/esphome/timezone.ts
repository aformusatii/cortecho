import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The POSIX TZ rule of an IANA zone ("Europe/Berlin" → "CET-1CEST,M3.5.0,M10.5.0/3"),
 * which is what Home Assistant puts into GetTimeResponse.timezone and what
 * hassmic hands to root as the Echo's time zone (clock.c).
 *
 * TZif files (version 2 and later) end with exactly this rule on its own line,
 * so it is read from the system's zoneinfo (node:24-slim ships tzdata).
 * Returns '' when the zone or its rule cannot be found: hassmic then leaves
 * the Echo's zone alone.
 */
export function posixTimezone(zone: string, zoneinfoDir = '/usr/share/zoneinfo'): string {
  // An IANA name only: no absolute paths or "..", the value comes from the environment.
  if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return '';
  try {
    const data = readFileSync(path.join(zoneinfoDir, zone));
    if (data.toString('latin1', 0, 4) !== 'TZif' || data[4] === 0) return '';
    const end = data.length - 1;
    if (data[end] !== 0x0a) return '';
    const start = data.lastIndexOf(0x0a, end - 1);
    if (start < 0) return '';
    const rule = data.toString('latin1', start + 1, end);
    return /^[A-Za-z0-9<>+\-,./:]+$/.test(rule) ? rule : '';
  } catch {
    return '';
  }
}
