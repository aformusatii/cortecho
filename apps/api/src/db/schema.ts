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
    /**
     * The Echo's MAC as 12 lower-case hex, learned from DeviceInfo at the first
     * connect. Identity across DHCP changes (spec §1.2 S3); a different MAC on a
     * row that has one is the `unexpected-device` problem. Unique when not null
     * (SQLite allows many NULLs: rows from before this column).
     */
    mac: text('mac'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('devices_name_idx').on(table.name),
    uniqueIndex('devices_host_port_idx').on(table.host, table.port),
    uniqueIndex('devices_mac_idx').on(table.mac),
  ],
);

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;

/** MACs the owner chose to hide from the Discovered section (spec §5.3). */
export const discoveryIgnored = sqliteTable('discovery_ignored', {
  mac: text('mac').primaryKey(),
  ignoredAt: text('ignored_at').notNull(),
});

/**
 * Small application state that is not a behaviour setting, so not in the
 * settings registry: today only `onboarding.completedAt` (spec §8.3).
 */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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
    /**
     * Who wrote it: an owner edit through the API/UI (`owner`), the one-time
     * environment import (`import`) or the reply-address upgrade copy
     * (`upgrade`). Only an owner edit says the owner meant the value; the
     * onboarding's "Your home" skip reads that distinction.
     */
    source: text('source').notNull().default('owner'),
  },
  (table) => [index('settings_changes_scope_idx').on(table.scope, table.id)],
);

export type SettingRow = typeof settings.$inferSelect;
export type SettingsChangeRow = typeof settingsChanges.$inferSelect;

/**
 * One connector: an MCP server plus the owner's settings for it. `slug` is
 * immutable because exposed tool names and turn history depend on it.
 * Secrets are encrypted at the edge by the repository, never read directly.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    catalogId: text('catalog_id'),
    transport: text('transport', { enum: ['streamable-http', 'sse', 'stdio'] })
      .notNull()
      .default('streamable-http'),
    url: text('url').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Owner text that tells the model what this account is (≤ 300). */
    description: text('description').notNull().default(''),
    authType: text('auth_type', { enum: ['none', 'headers', 'oauth'] })
      .notNull()
      .default('none'),
    /** Encrypted JSON `{name: value}`; write-only over the API. */
    headersEnc: text('headers_enc'),
    /** JSON `McpOauthConfig`. */
    oauthConfig: text('oauth_config').notNull().default('{}'),
    /** Encrypted. */
    oauthClientSecretEnc: text('oauth_client_secret_enc'),
    timeoutMs: integer('timeout_ms').notNull().default(10_000),
    maxResultChars: integer('max_result_chars').notNull().default(4000),
    useServerInstructions: integer('use_server_instructions', { mode: 'boolean' }).notNull().default(false),
    /** JSON: last error, connect time, negotiated version, transport used (UI only). */
    statusDetail: text('status_detail').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('mcp_servers_slug_idx').on(table.slug),
    uniqueIndex('mcp_servers_name_idx').on(table.name),
  ],
);

export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;

/**
 * The OAuth state of one connector, separate from its settings so “Disconnect
 * account” is one delete and a settings export never carries tokens.
 */
export const mcpCredentials = sqliteTable('mcp_credentials', {
  serverId: integer('server_id')
    .primaryKey()
    .references(() => mcpServers.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull().default(''),
  /** Encrypted DCR/CIMD registration result. */
  clientInfoEnc: text('client_info_enc'),
  /** Encrypted `{access_token, refresh_token?, token_type, scope, expires_at}`. */
  tokensEnc: text('tokens_enc'),
  /** Encrypted OAuthDiscoveryState. */
  discoveryEnc: text('discovery_enc'),
  /** Plain: shown in the UI. */
  grantedScope: text('granted_scope').notNull().default(''),
  accountLabel: text('account_label'),
  /** Plain ISO time: the UI and the proactive refresh read it. */
  expiresAt: text('expires_at'),
  updatedAt: text('updated_at').notNull(),
});

export type McpCredentialRow = typeof mcpCredentials.$inferSelect;

/**
 * Every tool a connector has ever listed, with the owner's policy. The row is
 * kept when the server stops listing it, so history and policy survive.
 */
export const mcpTools = sqliteTable(
  'mcp_tools',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** What the model sees (`<slug>__<name>`); never changes once given. */
    exposedName: text('exposed_name').notNull(),
    title: text('title').notNull().default(''),
    /** As listed, up to 2000 chars. */
    description: text('description').notNull().default(''),
    /** JSON Schema, as listed. */
    inputSchema: text('input_schema').notNull().default('{}'),
    /** JSON ToolAnnotations. */
    annotations: text('annotations').notNull().default('{}'),
    definitionHash: text('definition_hash').notNull(),
    /** The hash the owner's policy applies to; null = never approved. */
    approvedHash: text('approved_hash'),
    policy: text('policy', { enum: ['off', 'auto', 'confirm'] })
      .notNull()
      .default('off'),
    present: integer('present', { mode: 'boolean' }).notNull().default(true),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('mcp_tools_server_name_idx').on(table.serverId, table.name),
    uniqueIndex('mcp_tools_exposed_name_idx').on(table.exposedName),
  ],
);

export type McpToolRow = typeof mcpTools.$inferSelect;
export type NewMcpToolRow = typeof mcpTools.$inferInsert;
