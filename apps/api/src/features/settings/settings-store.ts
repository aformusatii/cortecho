import {
  buildSettings,
  DEFAULT_SETTINGS,
  isSecretSetting,
  SETTING_BY_KEY,
  type Settings,
} from '@cortecho/shared';
import type { Db } from '../../db/client.ts';
import { devices } from '../../db/schema.ts';
import { createLogger } from '../../lib/logger.ts';
import {
  assertValidSettings,
  crossFieldErrors,
  resolveSettings,
  SettingsValidationError,
  StaleSettingsError,
  validateChanges,
} from './effective.ts';
import { createSettingsRepository, type SettingsDiff } from './settings.repository.ts';

export { SettingsValidationError, StaleSettingsError } from './effective.ts';

const log = createLogger('settings');

/** The settings one turn runs with, frozen at the start of the turn. */
export type SettingsSnapshot = {
  version: number;
  settings: Settings;
};

/** A device's name and stored overrides, mirrored from the devices table. */
type DeviceOverrideState = { name: string; overrides: Record<string, unknown> };

/** A per-Echo patch touched a device that does not exist (the route answers 404). */
export class UnknownDeviceError extends Error {
  constructor(id: number) {
    super(`No device #${id}.`);
    this.name = 'UnknownDeviceError';
  }
}

/**
 * The settings, in memory, backed by SQLite: the global values and every
 * Echo's overrides. Writes go through here so every change is validated and
 * versioned; runtimes read one snapshot per turn.
 *
 * One version counter covers global and per-Echo changes, so a device form
 * loaded from the same version can get a 409 too.
 */
export class SettingsStore {
  private readonly repository;
  private values: Record<string, unknown>;
  private currentVersion: number;
  private readonly deviceStates = new Map<number, DeviceOverrideState>();
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  constructor(db: Db) {
    this.repository = createSettingsRepository(db);
    this.repository.ensureMeta();
    const { values, version } = this.repository.load();
    this.values = {};
    for (const [key, value] of Object.entries(values)) {
      const descriptor = SETTING_BY_KEY.get(key);
      if (!descriptor) {
        log.warn(`ignoring stored setting "${key}": no descriptor for it`);
        continue;
      }
      const parsed = descriptor.schema.safeParse(value);
      if (!parsed.success) {
        log.warn(`ignoring stored setting "${key}": ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
        continue;
      }
      this.values[key] = parsed.data;
    }
    this.currentVersion = version;

    for (const row of db
      .select({ id: devices.id, name: devices.name, overrides: devices.overrides })
      .from(devices)
      .all()) {
      this.deviceStates.set(row.id, { name: row.name, overrides: parseOverrides(row.overrides) });
    }
  }

  get version(): number {
    return this.currentVersion;
  }

  /** The global snapshot (defaults ⊕ global); `/api/ask` without a device and the OpenAI key. */
  current(): SettingsSnapshot {
    return { version: this.currentVersion, settings: resolveSettings(this.values) };
  }

  /** The snapshot one Echo's turns run with: defaults ⊕ global ⊕ that device's overrides. */
  forDevice(deviceId: number | null): SettingsSnapshot {
    if (deviceId === null) return this.current();
    const device = this.deviceStates.get(deviceId);
    return {
      version: this.currentVersion,
      settings: resolveSettings(this.values, device?.overrides ?? {}),
    };
  }

  /** Global values that differ from the built-in default (secrets included: callers filter). */
  storedValues(): Record<string, unknown> {
    return { ...this.values };
  }

  /** The flat, fully resolved global values (secrets included: callers filter). */
  resolvedValues(): Record<string, unknown> {
    return { ...DEFAULT_SETTINGS, ...this.values };
  }

  /** The flat, fully resolved values for one Echo (null = the global layer). */
  effectiveValues(deviceId: number | null): Record<string, unknown> {
    const overrides = deviceId === null ? {} : (this.deviceStates.get(deviceId)?.overrides ?? {});
    return { ...DEFAULT_SETTINGS, ...this.values, ...overrides };
  }

  deviceOverrides(deviceId: number): Record<string, unknown> {
    return { ...(this.deviceStates.get(deviceId)?.overrides ?? {}) };
  }

  /** How many keys a device overrides (the status card's count). */
  overrideCount(deviceId: number): number {
    return Object.keys(this.deviceStates.get(deviceId)?.overrides ?? {}).length;
  }

  hasSecret(key: string): boolean {
    if (!isSecretSetting(key)) return false;
    const value = this.values[key];
    return value !== null && value !== undefined && value !== '';
  }

  /**
   * Applies one batch of global changes. `expectedVersion` is the version the
   * form was loaded with; a stale value is rejected so two tabs cannot
   * silently overwrite each other. The whole resolved snapshot of every Echo
   * is validated too, so a global change cannot break a device's overrides.
   */
  apply(changes: Readonly<Record<string, unknown>>, expectedVersion: number): SettingsSnapshot {
    if (expectedVersion !== this.currentVersion) throw new StaleSettingsError(this.currentVersion);

    const normalised = validateChanges(changes);
    // A value equal to the built-in default is not stored: only differences
    // from the layer below are kept (spec §9.1).
    for (const [key, value] of Object.entries(normalised)) {
      const descriptor = SETTING_BY_KEY.get(key);
      if (descriptor && !descriptor.secret && sameValue(value, descriptor.default)) {
        normalised[key] = null;
      }
    }
    const candidate = { ...this.values, ...normalised };
    // Validate the whole resolved snapshot, not just the keys that changed.
    const resolved = resolveSettings(candidate);
    assertValidSettings(resolved);
    this.assertDevicesRemainValid(candidate);

    const diff: SettingsDiff[] = [];
    for (const [key, newValue] of Object.entries(normalised)) {
      const oldValue = this.values[key] ?? null;
      if (sameValue(oldValue, newValue)) continue;
      // A secret is stored, but its value never reaches the history.
      diff.push(
        isSecretSetting(key)
          ? { key, storedValue: newValue, oldValue: null, newValue: null }
          : { key, storedValue: newValue, oldValue, newValue },
      );
    }
    if (diff.length === 0) return this.current();

    const nextVersion = this.currentVersion + 1;
    this.repository.save(diff, nextVersion, new Date().toISOString(), { scope: 'global' });

    for (const [key, value] of Object.entries(normalised)) {
      if (value === null) delete this.values[key];
      else this.values[key] = value;
    }
    this.currentVersion = nextVersion;
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
    log.info(`settings saved as v${nextVersion}`, { keys: diff.map((change) => change.key) });
    return snapshot;
  }

  /**
   * Applies one batch of per-Echo overrides. Only `perEcho` keys are allowed;
   * null removes an override (inherit the global value again), and a value
   * equal to the global one is not stored at all.
   */
  applyDevice(
    deviceId: number,
    changes: Readonly<Record<string, unknown>>,
    expectedVersion: number,
  ): SettingsSnapshot {
    const device = this.deviceStates.get(deviceId);
    if (!device) throw new UnknownDeviceError(deviceId);
    if (expectedVersion !== this.currentVersion) throw new StaleSettingsError(this.currentVersion);

    const normalised = validateDeviceChanges(changes);
    const next: Record<string, unknown> = { ...device.overrides };
    for (const [key, value] of Object.entries(normalised)) {
      if (value === null) {
        delete next[key];
        continue;
      }
      const globalValue = this.values[key] ?? SETTING_BY_KEY.get(key)?.default;
      if (sameValue(value, globalValue)) delete next[key];
      else next[key] = value;
    }

    const resolved = resolveSettings(this.values, next);
    const fields = crossFieldErrors(resolved);
    if (Object.keys(fields).length > 0) throw new SettingsValidationError(fields);

    const diff: SettingsDiff[] = [];
    for (const key of new Set([...Object.keys(device.overrides), ...Object.keys(next)])) {
      const oldValue = device.overrides[key] ?? null;
      const newValue = next[key] ?? null;
      if (sameValue(oldValue, newValue)) continue;
      diff.push({ key, storedValue: newValue, oldValue, newValue });
    }
    if (diff.length === 0) return this.current();

    const nextVersion = this.currentVersion + 1;
    const scope = `device:${deviceId}`;
    this.repository.save(diff, nextVersion, new Date().toISOString(), {
      scope,
      device: { id: deviceId, overrides: next },
    });
    device.overrides = next;
    this.currentVersion = nextVersion;
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
    log.info(`settings saved for "${device.name}" as v${nextVersion}`, {
      keys: diff.map((change) => change.key),
    });
    return this.forDevice(deviceId);
  }

  /**
   * One-time import from the environment and SystemPrompt.md. Bypasses the
   * version check (there is nothing to conflict with) and is a no-op unless
   * the store is empty.
   */
  importValues(values: Readonly<Record<string, unknown>>): SettingsSnapshot | null {
    if (this.currentVersion !== 0 || Object.keys(this.values).length > 0) return null;
    const validated = validateChanges(values);
    if (Object.keys(validated).length === 0) return null;
    const resolved = resolveSettings(validated);
    try {
      assertValidSettings(resolved);
    } catch (error) {
      // A bad imported combination must not stop the start: keep what is valid.
      if (!(error instanceof SettingsValidationError)) throw error;
      log.warn(`imported settings are inconsistent: ${JSON.stringify(error.fields)}`);
    }
    const diff: SettingsDiff[] = [];
    for (const [key, newValue] of Object.entries(validated)) {
      const oldValue = this.values[key] ?? null;
      if (sameValue(oldValue, newValue)) continue;
      diff.push(
        isSecretSetting(key)
          ? { key, storedValue: newValue, oldValue: null, newValue: null }
          : { key, storedValue: newValue, oldValue, newValue },
      );
    }
    if (diff.length === 0) return null;
    const nextVersion = this.currentVersion + 1;
    this.repository.save(diff, nextVersion, new Date().toISOString(), { scope: 'global' });
    for (const [key, value] of Object.entries(validated)) this.values[key] = value;
    this.currentVersion = nextVersion;
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
    log.info(`imported ${diff.length} settings from the environment as v${nextVersion}`);
    return snapshot;
  }

  onChange(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(limit: number, scope?: string) {
    return this.repository.history(limit, scope);
  }

  /** Reverts a saved change to its `old_value`, honoring the row's scope. */
  revert(changeId: number): SettingsSnapshot {
    const change = this.repository.findChange(changeId);
    if (!change) throw new Error('No such change.');
    if (change.scope === 'global') {
      return this.apply({ [change.key]: change.oldValue }, this.currentVersion);
    }
    const deviceId = deviceScopeId(change.scope);
    if (deviceId === null) throw new Error(`Unknown change scope "${change.scope}".`);
    return this.applyDevice(deviceId, { [change.key]: change.oldValue }, this.currentVersion);
  }

  // --- Device registry mirror (kept in sync by the devices feature) ----------

  registerDevice(id: number, name: string, overrides: Record<string, unknown>): void {
    this.deviceStates.set(id, { name, overrides: { ...overrides } });
  }

  renameDevice(id: number, name: string): void {
    const device = this.deviceStates.get(id);
    if (device) device.name = name;
  }

  removeDevice(id: number): void {
    this.deviceStates.delete(id);
  }

  // --- Validation helpers ---------------------------------------------------

  /** A global batch must not make any Echo's resolved settings invalid. */
  private assertDevicesRemainValid(candidate: Record<string, unknown>): void {
    for (const [id, device] of this.deviceStates) {
      const fields = crossFieldErrors(resolveSettings(candidate, device.overrides));
      if (Object.keys(fields).length === 0) continue;
      const named = Object.fromEntries(
        Object.entries(fields).map(([key, message]) => [
          key,
          `Echo "${device.name}" (#${id}) would become invalid: ${message}`,
        ]),
      );
      throw new SettingsValidationError(named);
    }
  }
}

function validateDeviceChanges(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, string> = {};
  const normalised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const descriptor = SETTING_BY_KEY.get(key);
    if (!descriptor) {
      fields[key] = 'Unknown setting.';
      continue;
    }
    if (!descriptor.perEcho) {
      fields[key] = 'This setting applies to every Echo; change it in Settings.';
      continue;
    }
    if (value !== null) {
      const parsed = descriptor.schema.safeParse(value);
      if (!parsed.success) {
        fields[key] = parsed.error.issues[0]?.message ?? 'This value is not valid.';
        continue;
      }
      normalised[key] = parsed.data;
    } else {
      normalised[key] = null;
    }
  }
  if (Object.keys(fields).length > 0) throw new SettingsValidationError(fields);
  return normalised;
}

function deviceScopeId(scope: string): number | null {
  const match = /^device:(\d+)$/.exec(scope);
  return match?.[1] ? Number(match[1]) : null;
}

function parseOverrides(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Corrupt JSON: no overrides apply.
  }
  return {};
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The flat default map, exposed for tests and the UI's "default" markers. */
export function defaultSettingsValues(): Record<string, unknown> {
  return { ...DEFAULT_SETTINGS };
}

/** Builds the nested settings from the built-in defaults (tests, previews). */
export function defaultSettings(): Settings {
  return buildSettings(DEFAULT_SETTINGS);
}
