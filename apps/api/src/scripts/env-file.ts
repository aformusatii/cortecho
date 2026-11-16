import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Replaces `NAME=...` in an env file and keeps comments and other lines.
 * Appends the line when it is absent. Pure so it can be tested.
 */
export function upsertEnvValue(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${line}\n`;
}

/**
 * Writes a secret to an env file without ever printing it. The file is created
 * with mode 0600 and tightened if it already existed.
 */
export function writeEnvFile(file: string, name: string, value: string): void {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, upsertEnvValue(existing, name, value), { mode: 0o600 });
  chmodSync(file, 0o600);
}
