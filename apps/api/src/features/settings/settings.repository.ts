import type { SettingsChange } from '@cortecho/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { devices, settings, settingsChanges, settingsMeta } from '../../db/schema.ts';

/** Older history rows are deleted so the table never grows without bound. */
const KEEP_SETTINGS_CHANGES = 500;

export type SettingsDiff = {
  key: string;
  /** What is written to the settings table; null deletes the row. A secret's real value. */
  storedValue: unknown;
  /** For the history only: null for a secret's values (they are never stored there). */
  oldValue: unknown;
  newValue: unknown;
};

/**
 * SQLite access for settings. The store keeps the resolved values in memory
 * and writes through here; the database is read only at start.
 */
export function createSettingsRepository(db: Db) {
  function ensureMeta(): void {
    db.insert(settingsMeta)
      .values({ id: 1, version: 0 })
      .onConflictDoNothing({ target: settingsMeta.id })
      .run();
  }

  return {
    ensureMeta,

    load(): { values: Record<string, unknown>; version: number } {
      const rows = db.select().from(settings).all();
      const values: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          values[row.key] = JSON.parse(row.value);
        } catch {
          // A corrupt row must not stop the app; the default applies.
        }
      }
      const meta = db.select().from(settingsMeta).where(eq(settingsMeta.id, 1)).get();
      return { values, version: meta?.version ?? 0 };
    },

    /**
     * Writes one batch and its history atomically; the version is already
     * bumped by the caller. A `global` batch writes the settings table; a
     * `device:<id>` batch writes that device's `overrides` and never the
     * global table (one version counter covers both).
     */
    save(
      diff: SettingsDiff[],
      version: number,
      at: string,
      {
        scope = 'global',
        device,
      }: { scope?: string; device?: { id: number; overrides: Record<string, unknown> } } = {},
    ): void {
      db.transaction((tx) => {
        for (const change of diff) {
          if (scope === 'global') {
            if (change.storedValue === null) {
              tx.delete(settings).where(eq(settings.key, change.key)).run();
            } else {
              tx.insert(settings)
                .values({ key: change.key, value: JSON.stringify(change.storedValue), updatedAt: at })
                .onConflictDoUpdate({
                  target: settings.key,
                  set: { value: JSON.stringify(change.storedValue), updatedAt: at },
                })
                .run();
            }
          }
          tx.insert(settingsChanges)
            .values({
              at,
              scope,
              key: change.key,
              oldValue: change.oldValue === null ? null : JSON.stringify(change.oldValue),
              newValue: change.newValue === null ? null : JSON.stringify(change.newValue),
              version,
            })
            .run();
        }
        if (scope !== 'global') {
          if (!device) throw new Error(`A ${scope} change needs the device's overrides.`);
          tx.update(devices)
            .set({ overrides: JSON.stringify(device.overrides), updatedAt: at })
            .where(eq(devices.id, device.id))
            .run();
        }
        tx.insert(settingsMeta)
          .values({ id: 1, version })
          .onConflictDoUpdate({ target: settingsMeta.id, set: { version } })
          .run();
        tx.run(
          sql`delete from settings_changes where id <= (select max(id) from settings_changes) - ${KEEP_SETTINGS_CHANGES}`,
        );
      });
    },

    history(limit: number, scope?: string): SettingsChange[] {
      const rows = scope
        ? db
            .select()
            .from(settingsChanges)
            .where(eq(settingsChanges.scope, scope))
            .orderBy(desc(settingsChanges.id))
            .limit(limit)
            .all()
        : db.select().from(settingsChanges).orderBy(desc(settingsChanges.id)).limit(limit).all();
      return rows.map(toChange);
    },

    findChange(id: number): SettingsChange | null {
      const row = db.select().from(settingsChanges).where(eq(settingsChanges.id, id)).get();
      return row ? toChange(row) : null;
    },
  };
}

function toChange(row: typeof settingsChanges.$inferSelect): SettingsChange {
  return {
    id: row.id,
    at: row.at,
    scope: row.scope,
    key: row.key,
    oldValue: parseOrNull(row.oldValue),
    newValue: parseOrNull(row.newValue),
    version: row.version,
  };
}

function parseOrNull(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
