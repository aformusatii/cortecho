import { DEFAULT_SETTINGS } from '@cortecho/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { devices } from '../../db/schema.ts';
import { SettingsValidationError, StaleSettingsError } from './effective.ts';
import { SettingsStore } from './settings-store.ts';

function store() {
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  const settings = new SettingsStore(db);
  return { settings, db, close: () => sqlite.close() };
}

let ctx: ReturnType<typeof store>;
beforeEach(() => {
  ctx?.close();
  ctx = store();
});

describe('SettingsStore', () => {
  it('starts from the built-in defaults at version 0', () => {
    const { settings } = ctx;
    expect(settings.version).toBe(0);
    expect(settings.storedValues()).toEqual({});
    expect(settings.current().settings.tts.voice).toBe(DEFAULT_SETTINGS['tts.voice']);
    expect(settings.current().settings.followUp.mode).toBe('tool');
  });

  it('applies a batch, bumps the version once and notifies listeners', () => {
    const seen: number[] = [];
    ctx.settings.onChange((snapshot) => seen.push(snapshot.version));
    const snapshot = ctx.settings.apply({ 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 }, 0);
    expect(snapshot.version).toBe(1);
    expect(snapshot.settings.tts.voice).toBe('cedar');
    expect(snapshot.settings.vad.endSilenceMs).toBe(600);
    expect(seen).toEqual([1]);
    expect(ctx.settings.storedValues()).toEqual({ 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 });
  });

  it('resets a key to the default with null and does not bump a no-op batch', () => {
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    const reset = ctx.settings.apply({ 'tts.voice': null }, 1);
    expect(reset.settings.tts.voice).toBe(DEFAULT_SETTINGS['tts.voice']);
    expect(ctx.settings.storedValues()).toEqual({});
    const same = ctx.settings.apply({ 'tts.voice': DEFAULT_SETTINGS['tts.voice'] }, 2);
    expect(same.version).toBe(2);
  });

  it('rejects a stale version and names the current one', () => {
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    expect(() => ctx.settings.apply({ 'tts.voice': 'nova' }, 0)).toThrow(StaleSettingsError);
    try {
      ctx.settings.apply({ 'tts.voice': 'nova' }, 0);
    } catch (error) {
      expect((error as StaleSettingsError).version).toBe(1);
    }
  });

  it('rejects an unknown key and an invalid value, naming the field', () => {
    expect(() => ctx.settings.apply({ 'tts.unknown': 1 }, 0)).toThrow(SettingsValidationError);
    try {
      ctx.settings.apply({ 'vad.endSilenceMs': 5 }, 0);
    } catch (error) {
      expect((error as SettingsValidationError).fields).toHaveProperty('vad.endSilenceMs');
    }
    expect(ctx.settings.version).toBe(0);
  });

  it('checks cross-field rules on the resolved snapshot', () => {
    expect(() => ctx.settings.apply({ 'followUp.minWaitMs': 9000, 'followUp.maxWaitMs': 5000 }, 0)).toThrow(
      SettingsValidationError,
    );
    expect(() => ctx.settings.apply({ 'echo.pingTimeoutMs': 5000 }, 0)).toThrow(SettingsValidationError);
    expect(ctx.settings.version).toBe(0);
  });

  it('writes history and can revert a change', () => {
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    ctx.settings.apply({ 'tts.voice': 'nova' }, 1);
    const history = ctx.settings.history(10);
    expect(history[0]).toMatchObject({
      key: 'tts.voice',
      oldValue: 'cedar',
      newValue: 'nova',
      version: 2,
      scope: 'global',
    });
    const change = history[0];
    if (!change) throw new Error('expected a history row');
    const reverted = ctx.settings.revert(change.id);
    expect(reverted.settings.tts.voice).toBe('cedar');
    expect(reverted.version).toBe(3);
    expect(ctx.settings.history(10)[0]).toMatchObject({ oldValue: 'nova', newValue: 'cedar' });
  });

  it('persists a secret across a restart, still out of the history', () => {
    ctx.settings.apply({ 'openai.apiKey': 'sk-test' }, 0);
    const restarted = new SettingsStore(ctx.db);
    expect(restarted.hasSecret('openai.apiKey')).toBe(true);
    expect(restarted.current().settings.openai.apiKey).toBe('sk-test');
    expect(restarted.history(10)[0]).toMatchObject({ oldValue: null, newValue: null });
  });

  it('keeps a secret out of the history and can clear it', () => {
    ctx.settings.apply({ 'openai.apiKey': 'sk-test' }, 0);
    expect(ctx.settings.hasSecret('openai.apiKey')).toBe(true);
    expect(ctx.settings.current().settings.openai.apiKey).toBe('sk-test');
    expect(ctx.settings.history(10)[0]).toMatchObject({
      key: 'openai.apiKey',
      oldValue: null,
      newValue: null,
    });
    ctx.settings.apply({ 'openai.apiKey': null }, 1);
    expect(ctx.settings.hasSecret('openai.apiKey')).toBe(false);
  });

  it('reloads stored values and the version from the database', () => {
    const { db, sqlite } = openDatabase(':memory:');
    runMigrations(db);
    const first = new SettingsStore(db);
    first.apply({ 'tts.voice': 'cedar' }, 0);
    // A new store on the same database is what a restart builds.
    const second = new SettingsStore(db);
    expect(second.version).toBe(1);
    expect(second.current().settings.tts.voice).toBe('cedar');
    sqlite.close();
  });

  describe('per-Echo overrides', () => {
    function register(id = 1, name = 'Kitchen', overrides: Record<string, unknown> = {}) {
      ctx.db
        .insert(devices)
        .values({
          id,
          name,
          kind: 'echo',
          host: '192.168.1.50',
          port: 26053,
          apiKey: null,
          enabled: true,
          prompt: '',
          overrides: JSON.stringify(overrides),
          nodeName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
      ctx.settings.registerDevice(id, name, overrides);
    }

    it('resolves defaults ⊕ global ⊕ that device only', () => {
      register();
      ctx.settings.apply({ 'tts.speed': 1.2 }, 0);
      expect(ctx.settings.forDevice(null).settings.tts.speed).toBe(1.2);
      expect(ctx.settings.forDevice(1).settings.tts.speed).toBe(1.2);
      ctx.settings.applyDevice(1, { 'tts.speed': 0.8 }, 1);
      expect(ctx.settings.forDevice(1).settings.tts.speed).toBe(0.8);
      expect(ctx.settings.forDevice(null).settings.tts.speed).toBe(1.2);
      expect(ctx.settings.overrideCount(1)).toBe(1);
      expect(ctx.settings.version).toBe(2);
    });

    it('rejects keys that are not perEcho, and inherits with null', () => {
      register();
      expect(() => ctx.settings.applyDevice(1, { 'tts.model': 'tts-1' }, 0)).toThrow(SettingsValidationError);
      expect(() => ctx.settings.applyDevice(1, { 'nope.nope': 1 }, 0)).toThrow(SettingsValidationError);
      ctx.settings.applyDevice(1, { 'vad.endSilenceMs': 600 }, 0);
      const snapshot = ctx.settings.applyDevice(1, { 'vad.endSilenceMs': null }, 1);
      expect(snapshot.settings.vad.endSilenceMs).toBe(DEFAULT_SETTINGS['vad.endSilenceMs']);
      expect(ctx.settings.deviceOverrides(1)).toEqual({});
    });

    it('does not store a value equal to the global layer', () => {
      register();
      ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
      ctx.settings.applyDevice(1, { 'tts.voice': 'cedar' }, 1);
      expect(ctx.settings.deviceOverrides(1)).toEqual({});
      expect(ctx.settings.version).toBe(1);
    });

    it('rejects a global change that would break a device, naming it', () => {
      register(1, 'Kitchen');
      ctx.settings.applyDevice(1, { 'followUp.maxWaitMs': 4000 }, 0);
      try {
        ctx.settings.apply({ 'followUp.minWaitMs': 5000 }, 1);
        throw new Error('expected the change to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsValidationError);
        expect(Object.values((error as SettingsValidationError).fields).join(' ')).toContain('Kitchen');
      }
      expect(ctx.settings.version).toBe(1);
    });

    it('records device history and reloads overrides after a restart', () => {
      register(1, 'Kitchen');
      ctx.settings.applyDevice(1, { 'tts.voice': 'nova' }, 0);
      expect(ctx.settings.history(10)[0]).toMatchObject({
        scope: 'device:1',
        key: 'tts.voice',
        oldValue: null,
        newValue: 'nova',
      });
      const restarted = new SettingsStore(ctx.db);
      expect(restarted.forDevice(1).settings.tts.voice).toBe('nova');
      expect(restarted.overrideCount(1)).toBe(1);
    });
  });
});
