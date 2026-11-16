import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { upsertEnvValue, writeEnvFile } from './env-file.ts';

describe('upsertEnvValue', () => {
  it('appends a missing value and keeps comments', () => {
    const input = '# my settings\nTZ=UTC\n';
    expect(upsertEnvValue(input, 'ECHO_API_KEY', 'abc')).toBe('# my settings\nTZ=UTC\nECHO_API_KEY=abc\n');
  });

  it('replaces an existing value without touching the rest', () => {
    expect(upsertEnvValue('ECHO_API_KEY=old\nTZ=UTC\n', 'ECHO_API_KEY', 'new')).toBe(
      'ECHO_API_KEY=new\nTZ=UTC\n',
    );
  });

  it('adds a newline when the file does not end with one', () => {
    expect(upsertEnvValue('TZ=UTC', 'ECHO_API_KEY', 'abc')).toBe('TZ=UTC\nECHO_API_KEY=abc\n');
  });

  it('creates a 0600 file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortecho-key-'));
    const file = path.join(dir, 'cortecho.env');
    writeFileSync(file, '# existing\nTZ=UTC\n', { mode: 0o644 });
    writeEnvFile(file, 'ECHO_API_KEY', 'secret-value');
    expect(readFileSync(file, 'utf8')).toContain('ECHO_API_KEY=secret-value');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tightens the mode of an existing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortecho-key-'));
    const file = path.join(dir, 'cortecho.env');
    writeFileSync(file, 'ECHO_API_KEY=old\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    writeEnvFile(file, 'ECHO_API_KEY', 'new');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
