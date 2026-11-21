import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SETTING_DESCRIPTORS } from '@cortecho/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { configEnvNames, loadConfig } from './config.ts';
import { REPO_ROOT } from './env.ts';

const SERVER_ENV = ['NODE_ENV', 'HOST', 'PORT', 'DATABASE_PATH', 'LOG_LEVEL'];
const DEVICE_IMPORT_ENV = ['ECHO_HOST', 'ECHO_PORT', 'ECHO_API_KEY'];
const COMPOSE_ENV = ['APP_PORT', 'DATA_DIR'];

const saved = { ...process.env };
afterAll(() => {
  process.env = saved;
});

describe('TOOLS_FILE', () => {
  it('reads endpoints and scripts from a mounted JSON file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortecho-config-'));
    const file = path.join(dir, 'tools.json');
    writeFileSync(
      file,
      JSON.stringify({
        httpToolEndpoints: { weather: { url: 'http://192.168.1.10:8006/weather' } },
        shellToolScripts: { backup: { path: '/app/scripts/backup.sh' } },
      }),
    );
    process.env.TOOLS_FILE = file;
    const config = loadConfig();
    expect(config.tools.httpEndpoints.weather?.url).toBe('http://192.168.1.10:8006/weather');
    expect(config.tools.shellScripts.backup?.path).toBe('/app/scripts/backup.sh');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TOOLS_FILE;
  });

  it('lets the file win over the JSON in the environment', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortecho-config-'));
    const file = path.join(dir, 'tools.json');
    writeFileSync(
      file,
      JSON.stringify({ httpToolEndpoints: { weather: { url: 'http://192.168.1.10/from-file' } } }),
    );
    process.env.TOOLS_FILE = file;
    process.env.HTTP_TOOL_ENDPOINTS = JSON.stringify({ weather: { url: 'http://192.168.1.10/from-env' } });
    expect(loadConfig().tools.httpEndpoints.weather?.url).toBe('http://192.168.1.10/from-file');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TOOLS_FILE;
    delete process.env.HTTP_TOOL_ENDPOINTS;
  });

  it('rejects a missing tools file with a clear message', () => {
    process.env.TOOLS_FILE = '/nonexistent/tools.json';
    expect(() => loadConfig()).toThrow(/TOOLS_FILE: could not read/);
    delete process.env.TOOLS_FILE;
  });
});

describe('DISCOVERY_EXTRA_TARGETS', () => {
  it('parses comma-separated host:port entries', () => {
    process.env.DISCOVERY_EXTRA_TARGETS = '192.168.1.50:26053, 10.0.0.5:3000';
    try {
      expect(loadConfig().discovery.extraTargets).toEqual([
        { host: '192.168.1.50', port: 26053 },
        { host: '10.0.0.5', port: 3000 },
      ]);
    } finally {
      delete process.env.DISCOVERY_EXTRA_TARGETS;
    }
  });

  it('refuses an entry that is not host:port', () => {
    for (const value of ['nope', '1.2.3.4:', '1.2.3.4:99999', ':26053']) {
      process.env.DISCOVERY_EXTRA_TARGETS = value;
      try {
        expect(() => loadConfig()).toThrow(/DISCOVERY_EXTRA_TARGETS/);
      } finally {
        delete process.env.DISCOVERY_EXTRA_TARGETS;
      }
    }
  });
});

/**
 * The docs and the code must not drift apart. The brief's example of such a
 * drift: OPENAI_BASE_URL existed in config.ts but was in no example or doc.
 */
describe('configuration documentation', () => {
  it('documents every environment variable and every setting', () => {
    loadConfig();
    const docs = readFileSync(path.join(REPO_ROOT, 'docs/configuration.md'), 'utf8');
    const envNames = new Set([
      ...configEnvNames(),
      ...SERVER_ENV,
      ...DEVICE_IMPORT_ENV,
      ...SETTING_DESCRIPTORS.flatMap((descriptor) => (descriptor.env ? [descriptor.env] : [])),
    ]);

    for (const name of envNames) {
      expect(docs, `docs/configuration.md must mention ${name}`).toContain(`\`${name}\``);
    }
    for (const descriptor of SETTING_DESCRIPTORS) {
      expect(docs, `docs/configuration.md must mention ${descriptor.key}`).toContain(`\`${descriptor.key}\``);
    }
  });

  it('keeps the example files limited to known variables', () => {
    loadConfig();
    const known = new Set([
      ...configEnvNames(),
      ...SERVER_ENV,
      ...DEVICE_IMPORT_ENV,
      ...COMPOSE_ENV,
      ...SETTING_DESCRIPTORS.flatMap((descriptor) => (descriptor.env ? [descriptor.env] : [])),
    ]);
    for (const file of ['.env.example', 'cortecho.env.example']) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const names = [...content.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string);
      expect(names.length, `${file} should set at least a few variables`).toBeGreaterThan(3);
      for (const name of names) expect(known.has(name), `${file}: unknown variable ${name}`).toBe(true);
    }
  });
});
