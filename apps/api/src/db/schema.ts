import { TURN_OUTCOMES, TURN_SOURCES } from '@cortecho/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The Echos the gateway serves. One row per hassmic (ESPHome API) instance.
 * `(host, port)` is unique because two rows for one Echo would mean two
 * clients, and hassmic gives the voice assistant to the first subscriber only.
 */
export const devices = sqliteTable(
  'devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** 'test': a fake Echo; quiet reconnects, left out of "all Echos" announcements. */
    kind: text('kind', { enum: ['echo', 'test'] })
      .notNull()
      .default('echo'),
    host: text('host').notNull(),
    port: integer('port').notNull().default(26053),
    /** The Echo's API key as entered (base64 of 32 bytes), plaintext in the DB (decision 2). */
    apiKey: text('api_key'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** The owner's text for this Echo, the third prompt layer (≤ 4000 chars). */
    prompt: text('prompt').notNull().default(''),
    /** JSON object; only the per-Echo setting overrides, never the defaults. */
    overrides: text('overrides').notNull().default('{}'),
    /** hassmic's node name, learned at the first connect; a different name later = another device. */
    nodeName: text('node_name'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('devices_name_idx').on(table.name),
    uniqueIndex('devices_host_port_idx').on(table.host, table.port),
  ],
);

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;

/**
 * One row per voice turn, /api/ask or /api/say request: what was heard,
 * what was answered, which tools ran and how long each step took. The status
 * page shows the latest rows. Audio is never stored here.
 */
export const turns = sqliteTable(
  'turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: TURN_SOURCES }).notNull(),
    outcome: text('outcome', { enum: TURN_OUTCOMES }).notNull(),
    // ISO-8601 strings sort correctly as text and need no conversion in JSON.
    startedAt: text('started_at').notNull(),
    /** Null for old rows, for /api/ask without a device, and after the device is deleted. */
    deviceId: integer('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** The settings version the turn ran with (null for rows from before versioning). */
    settingsVersion: integer('settings_version'),
    transcript: text('transcript'),
    reply: text('reply'),
    searchDisplay: text('search_display'),
    // JSON arrays/objects as text: they are only ever read back whole.
    toolCalls: text('tool_calls').notNull().default('[]'),
    timings: text('timings').notNull().default('{}'),
    error: text('error'),
  },
  (table) => [
    index('turns_started_at_idx').on(table.startedAt),
    index('turns_device_id_idx').on(table.deviceId),
    check('turns_source_check', sql`${table.source} IN ('voice', 'ask', 'say')`),
    check('turns_outcome_check', sql`${table.outcome} IN ('answered', 'no-speech', 'error', 'aborted')`),
  ],
);

export type TurnRow = typeof turns.$inferSelect;
export type NewTurnRow = typeof turns.$inferInsert;

/**
 * The settings the owner changed, as global values. A key that is absent means
 * "use the built-in default", so new defaults in code still reach settings the
 * owner never touched. `openai.apiKey` lives here too (plaintext, write-only
 * over the API).
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON, validated against the descriptor on every write and at load. */
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** One row holding the settings version (incremented once per saved batch). */
export const settingsMeta = sqliteTable('settings_meta', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull().default(0),
});

/** History of saved changes; the newest KEEP_SETTINGS_CHANGES are kept. */
export const settingsChanges = sqliteTable(
  'settings_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    /** 'global' (and later 'device:<id>'). */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    /** JSON; null for a secret (its values are never stored) and for "default". */
    oldValue: text('old_value'),
    newValue: text('new_value'),
    version: integer('version').notNull(),
  },
  (table) => [index('settings_changes_scope_idx').on(table.scope, table.id)],
);

export type SettingRow = typeof settings.$inferSelect;
export type SettingsChangeRow = typeof settingsChanges.$inferSelect;
