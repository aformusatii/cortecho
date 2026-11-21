/**
 * MAC addresses as the identity of an Echo (spec §1.2 S3).
 *
 * hassmic reports it in several shapes: `DeviceInfo` uses `mac()`, upper-case
 * with colons ("02:00:00:00:00:01"); mDNS TXT and the Noise server hello use
 * `mac_plain()`, 12 lower-case hex ("020000000001"). The database stores the
 * plain form only, so two spellings can never become two devices.
 */
export function normalizeMac(value: string): string | null {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 12 ? hex : null;
}
