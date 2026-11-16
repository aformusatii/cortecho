import type { DeviceKind } from '@cortecho/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { type DeviceRow, devices, turns } from '../../db/schema.ts';

/** A device as the API and the manager use it: the key is present here, never in a response. */
export type Device = {
  id: number;
  name: string;
  kind: DeviceKind;
  host: string;
  port: number;
  /** The base64 key as entered; null = plaintext link. */
  apiKey: string | null;
  enabled: boolean;
  prompt: string;
  overrides: Record<string, unknown>;
  /** hassmic's node name, learned at the first connect. */
  nodeName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceInput = {
  name: string;
  kind: DeviceKind;
  host: string;
  port: number;
  apiKey: string | null;
  enabled: boolean;
  prompt: string;
};

/** Which unique column a create/update collided with. */
export class DuplicateDeviceError extends Error {
  readonly field: 'name' | 'host';
  constructor(field: 'name' | 'host') {
    super(
      field === 'name'
        ? 'Another Echo already uses this name.'
        : 'Another Echo already uses this address and port.',
    );
    this.name = 'DuplicateDeviceError';
    this.field = field;
  }
}

/**
 * SQLite access for devices. The manager keeps the live runtime in memory;
 * this is only the rows. `overrides` is a JSON object of per-Echo settings.
 */
export function createDevicesRepository(db: Db) {
  function row(value: DeviceRow): Device {
    return {
      id: value.id,
      name: value.name,
      kind: value.kind,
      host: value.host,
      port: value.port,
      apiKey: value.apiKey,
      enabled: value.enabled,
      prompt: value.prompt,
      overrides: parseOverrides(value.overrides),
      nodeName: value.nodeName,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }

  const everything = () => db.select().from(devices).orderBy(asc(devices.id)).all().map(row);

  return {
    list: everything,

    get(id: number): Device | null {
      const found = db.select().from(devices).where(eq(devices.id, id)).get();
      return found ? row(found) : null;
    },

    count(): number {
      return db.select({ id: devices.id }).from(devices).all().length;
    },

    create(input: DeviceInput): Device {
      const now = new Date().toISOString();
      try {
        const created = db
          .insert(devices)
          .values({
            name: input.name,
            kind: input.kind,
            host: input.host,
            port: input.port,
            apiKey: input.apiKey,
            enabled: input.enabled,
            prompt: input.prompt,
            overrides: '{}',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        return row(created);
      } catch (error) {
        throw toDuplicate(error);
      }
    },

    update(id: number, input: DeviceInput): Device | null {
      try {
        const updated = db
          .update(devices)
          .set({
            name: input.name,
            kind: input.kind,
            host: input.host,
            port: input.port,
            apiKey: input.apiKey,
            enabled: input.enabled,
            prompt: input.prompt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(devices.id, id))
          .returning()
          .get();
        return updated ? row(updated) : null;
      } catch (error) {
        throw toDuplicate(error);
      }
    },

    setOverrides(id: number, overrides: Readonly<Record<string, unknown>>): Device | null {
      const updated = db
        .update(devices)
        .set({ overrides: JSON.stringify(overrides), updatedAt: new Date().toISOString() })
        .where(eq(devices.id, id))
        .returning()
        .get();
      return updated ? row(updated) : null;
    },

    setNodeName(id: number, nodeName: string | null): Device | null {
      const updated = db
        .update(devices)
        .set({ nodeName, updatedAt: new Date().toISOString() })
        .where(eq(devices.id, id))
        .returning()
        .get();
      return updated ? row(updated) : null;
    },

    /**
     * Deletes the row. The turns keep their history with device_id null: the
     * generated migration's FK has no ON DELETE action (SQLite cannot add one
     * with ALTER TABLE), so the nulling is explicit here.
     */
    remove(id: number): boolean {
      return db.transaction((tx) => {
        tx.update(turns).set({ deviceId: null }).where(eq(turns.deviceId, id)).run();
        const result = tx.delete(devices).where(eq(devices.id, id)).run();
        return result.changes > 0;
      });
    },
  };
}

export type DevicesRepository = ReturnType<typeof createDevicesRepository>;

function parseOverrides(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // A corrupt row must not stop the app; no overrides apply.
  }
  return {};
}

function toDuplicate(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('UNIQUE constraint failed')) {
    if (message.includes('devices.name')) return new DuplicateDeviceError('name');
    if (message.includes('devices.host')) return new DuplicateDeviceError('host');
  }
  return error;
}
