import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { setLogLevel } from '../../lib/logger.ts';
import { createDevicesRepository } from '../devices/devices.repository.ts';
import {
  importSettingsFromEnvironment,
  migrateReplyBaseUrlFromEnvironment,
  warnStaleEnvironment,
} from './import.ts';
import { SettingsStore } from './settings-store.ts';

const URL_VALUE = 'http://192.168.1.10:3000';

const open: { close: () => void }[] = [];

afterEach(() => {
  setLogLevel('silent');
  for (const database of open.splice(0)) database.close();
});

/**
 * An installation that is already in use: settings saved before this upgrade
 * (so the one-time environment import does not run) and an Echo row.
 */
function inUseStore() {
  const { db, sqlite } = openDatabase(':memory:');
  open.push({ close: () => sqlite.close() });
  runMigrations(db);
  const store = new SettingsStore(db);
  store.apply({ 'tts.voice': 'cedar' }, store.version);
  const repository = createDevicesRepository(db);
  const device = repository.create({
    name: 'Kitchen',
    kind: 'echo',
    host: '192.168.1.50',
    port: 26053,
    apiKey: null,
    enabled: true,
    prompt: '',
    mac: null,
  });
  return { db, store, device };
}

describe('migrateReplyBaseUrlFromEnvironment', () => {
  it('copies the variable into an in-use database and records it in the history', () => {
    const { store, device } = inUseStore();
    const version = store.version;

    const copied = migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: `${URL_VALUE}/` });

    expect(copied).toBe(URL_VALUE);
    expect(store.version).toBe(version + 1);
    expect(store.storedValues()['network.replyBaseUrl']).toBe(URL_VALUE);
    expect(store.history(1)[0]).toMatchObject({
      scope: 'global',
      key: 'network.replyBaseUrl',
      oldValue: null,
      newValue: URL_VALUE,
    });
    // The turn snapshot (what the pipeline reads) carries the copied address.
    expect(store.forDevice(device.id).settings.network.replyBaseUrl).toBe(URL_VALUE);
  });

  it('leaves a stored value alone, including one saved as empty in the UI', () => {
    const { db, store } = inUseStore();
    store.apply({ 'network.replyBaseUrl': 'http://10.0.0.5:3000' }, store.version);
    const version = store.version;

    expect(migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE })).toBeNull();
    expect(store.current().settings.network.replyBaseUrl).toBe('http://10.0.0.5:3000');
    expect(store.version).toBe(version);

    // Cleared in the UI: the key is stored as '', so the old variable must not come back.
    store.apply({ 'network.replyBaseUrl': '' }, store.version);
    expect(migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE })).toBeNull();
    expect(store.current().settings.network.replyBaseUrl).toBe('');

    // Reloading the database (the next start) sees the empty value as stored too.
    const restarted = new SettingsStore(db);
    expect(migrateReplyBaseUrlFromEnvironment(restarted, { REPLY_AUDIO_BASE_URL: URL_VALUE })).toBeNull();
  });

  it('does not copy an invalid value, warns, and leaves the setting empty', () => {
    const { store } = inUseStore();
    const version = store.version;
    const warnings: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => warnings.push(String(line));
    setLogLevel('warn');
    try {
      expect(
        migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: 'http://8.8.8.8:3000' }),
      ).toBeNull();
    } finally {
      console.error = original;
    }
    expect(store.version).toBe(version);
    expect(store.current().settings.network.replyBaseUrl).toBe('');
    expect(warnings.join('\n')).toContain('REPLY_AUDIO_BASE_URL');
  });

  it('is a no-op on the second start: no value and no second history row', () => {
    const { db, store } = inUseStore();
    migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE });
    const version = store.version;
    const history = store.history(10).length;

    const restarted = new SettingsStore(db);
    expect(migrateReplyBaseUrlFromEnvironment(restarted, { REPLY_AUDIO_BASE_URL: URL_VALUE })).toBeNull();
    expect(restarted.version).toBe(version);
    expect(restarted.history(10)).toHaveLength(history);
  });

  it('lets the normal one-time import take it on a fresh database', () => {
    const { db, sqlite } = openDatabase(':memory:');
    open.push({ close: () => sqlite.close() });
    runMigrations(db);
    const store = new SettingsStore(db);
    importSettingsFromEnvironment(store, {
      env: { REPLY_AUDIO_BASE_URL: URL_VALUE },
      promptFile: null,
    });
    expect(store.storedValues()['network.replyBaseUrl']).toBe(URL_VALUE);
    const version = store.version;

    expect(migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE })).toBeNull();
    expect(store.version).toBe(version);
  });

  it('does not stop a fresh start on an invalid variable, and does not copy it', () => {
    const { db, sqlite } = openDatabase(':memory:');
    open.push({ close: () => sqlite.close() });
    runMigrations(db);
    const store = new SettingsStore(db);
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => lines.push(String(line));
    setLogLevel('warn');
    try {
      expect(() =>
        importSettingsFromEnvironment(store, {
          env: { REPLY_AUDIO_BASE_URL: 'http://8.8.8.8:3000' },
          promptFile: null,
        }),
      ).not.toThrow();
      expect(
        migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: 'http://8.8.8.8:3000' }),
      ).toBeNull();
    } finally {
      console.error = original;
    }
    expect(store.storedValues()).not.toHaveProperty('network.replyBaseUrl');
    expect(store.current().settings.network.replyBaseUrl).toBe('');
    expect(lines.join('\n')).toContain('REPLY_AUDIO_BASE_URL');
  });

  it('lists the variable in the stale-environment warning only once it is stored', () => {
    const { store } = inUseStore();
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => lines.push(String(line));
    setLogLevel('warn');
    try {
      warnStaleEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE, OPENAI_TIMEOUT_MS: '30000' });
      expect(lines.join('\n')).toContain('OPENAI_TIMEOUT_MS');
      expect(lines.join('\n')).not.toContain('REPLY_AUDIO_BASE_URL');

      lines.length = 0;
      migrateReplyBaseUrlFromEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE });
      warnStaleEnvironment(store, { REPLY_AUDIO_BASE_URL: URL_VALUE, OPENAI_TIMEOUT_MS: '30000' });
      expect(lines.join('\n')).toContain('REPLY_AUDIO_BASE_URL');
    } finally {
      console.error = original;
    }
  });
});
