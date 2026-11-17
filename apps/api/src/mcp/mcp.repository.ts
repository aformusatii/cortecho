import type {
  McpAuthType,
  McpOauthConfig,
  McpToolAnnotations,
  McpToolPolicy,
  McpTransport,
} from '@cortecho/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  type McpCredentialRow,
  type McpServerRow,
  type McpToolRow,
  mcpCredentials,
  mcpServers,
  mcpTools,
} from '../db/schema.ts';
import { type SecretBox, SecretBoxError } from '../lib/secret-box.ts';

/** Connectors with a secret (headers/OAuth) need CORTECHO_SECRET_KEY. */
export class SecretKeyMissingError extends Error {
  constructor() {
    super(
      'CORTECHO_SECRET_KEY is not set, so passwords and tokens cannot be stored encrypted. ' +
        'Connectors without authentication still work.',
    );
    this.name = 'SecretKeyMissingError';
  }
}

export class DuplicateConnectorError extends Error {
  readonly field: 'slug' | 'name';

  constructor(field: 'slug' | 'name', message: string) {
    super(message);
    this.name = 'DuplicateConnectorError';
    this.field = field;
  }
}

export type McpServerWrite = {
  slug: string;
  name: string;
  catalogId: string | null;
  transport: McpTransport;
  url: string;
  enabled: boolean;
  description: string;
  authType: McpAuthType;
  /** Plaintext in, encrypted at rest. `null` clears; `undefined` keeps (update). */
  headers?: Record<string, string> | null;
  oauthConfig: McpOauthConfig;
  /** Plaintext in, encrypted at rest. */
  clientSecret?: string | null;
  timeoutMs: number;
  maxResultChars: number;
  useServerInstructions: boolean;
};

export type McpServerStatusDetail = {
  lastError?: string | null;
  lastConnectedAt?: string | null;
  protocolVersion?: string | null;
  transportUsed?: McpTransport | null;
  serverInstructions?: string | null;
  /** Set after the first tools/list, so a server that later adds a tool is not "first sync". */
  toolsSyncedAt?: string | null;
};

export type McpCredentials = {
  issuer: string;
  clientInfo: unknown | null;
  tokens: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_at?: number | string;
    [key: string]: unknown;
  } | null;
  discovery: unknown | null;
  grantedScope: string;
  accountLabel: string | null;
  expiresAt: string | null;
  updatedAt: string;
};

export type McpToolWrite = {
  name: string;
  exposedName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  definitionHash: string;
  approvedHash: string | null;
  policy: McpToolPolicy;
};

const EMPTY_OAUTH: McpOauthConfig = { registration: 'auto' };

export function createMcpRepository(db: Db, secretBox: SecretBox | null) {
  function assertSecretsAllowed(authType: McpAuthType): void {
    if (authType !== 'none' && !secretBox) throw new SecretKeyMissingError();
  }

  function encrypt(value: unknown): string {
    if (!secretBox) throw new SecretKeyMissingError();
    return secretBox.encryptJson(value);
  }

  function decrypt<T>(value: string | null): T | null {
    if (!value || !secretBox) return null;
    try {
      return secretBox.decryptJson<T>(value);
    } catch (error) {
      if (error instanceof SecretBoxError) return null;
      throw error;
    }
  }

  return {
    secretKeyConfigured(): boolean {
      return secretBox !== null;
    },

    list(): McpServerRow[] {
      return db.select().from(mcpServers).orderBy(mcpServers.id).all();
    },

    get(id: number): McpServerRow | null {
      return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get() ?? null;
    },

    getBySlug(slug: string): McpServerRow | null {
      return db.select().from(mcpServers).where(eq(mcpServers.slug, slug)).get() ?? null;
    },

    create(input: McpServerWrite): McpServerRow {
      assertSecretsAllowed(input.authType);
      const duplicate = db
        .select({ slug: mcpServers.slug, name: mcpServers.name })
        .from(mcpServers)
        .all()
        .find((row) => row.slug === input.slug || row.name === input.name);
      if (duplicate) {
        throw duplicate.slug === input.slug
          ? new DuplicateConnectorError('slug', `The slug "${input.slug}" is already used.`)
          : new DuplicateConnectorError('name', `A connector named "${input.name}" already exists.`);
      }
      const now = new Date().toISOString();
      return db
        .insert(mcpServers)
        .values({
          slug: input.slug,
          name: input.name,
          catalogId: input.catalogId,
          transport: input.transport,
          url: input.url,
          enabled: input.enabled,
          description: input.description,
          authType: input.authType,
          headersEnc: input.headers ? encrypt(input.headers) : null,
          oauthConfig: JSON.stringify(input.oauthConfig ?? EMPTY_OAUTH),
          oauthClientSecretEnc: input.clientSecret ? encrypt(input.clientSecret) : null,
          timeoutMs: input.timeoutMs,
          maxResultChars: input.maxResultChars,
          useServerInstructions: input.useServerInstructions,
          statusDetail: '{}',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    },

    update(id: number, input: McpServerWrite): McpServerRow | null {
      assertSecretsAllowed(input.authType);
      const existing = this.get(id);
      if (!existing) return null;
      const now = new Date().toISOString();
      return db
        .update(mcpServers)
        .set({
          name: input.name,
          catalogId: input.catalogId,
          transport: input.transport,
          url: input.url,
          enabled: input.enabled,
          description: input.description,
          authType: input.authType,
          ...(input.headers === undefined
            ? {}
            : { headersEnc: input.headers === null ? null : encrypt(input.headers) }),
          oauthConfig: JSON.stringify(input.oauthConfig ?? EMPTY_OAUTH),
          ...(input.clientSecret === undefined
            ? {}
            : { oauthClientSecretEnc: input.clientSecret === null ? null : encrypt(input.clientSecret) }),
          timeoutMs: input.timeoutMs,
          maxResultChars: input.maxResultChars,
          useServerInstructions: input.useServerInstructions,
          updatedAt: now,
        })
        .where(eq(mcpServers.id, id))
        .returning()
        .get();
    },

    setEnabled(id: number, enabled: boolean): void {
      db.update(mcpServers)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(eq(mcpServers.id, id))
        .run();
    },

    setStatusDetail(id: number, detail: McpServerStatusDetail): void {
      db.update(mcpServers)
        .set({ statusDetail: JSON.stringify(detail), updatedAt: new Date().toISOString() })
        .where(eq(mcpServers.id, id))
        .run();
    },

    remove(id: number): void {
      db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
    },

    /** Deletes OAuth state only (Disconnect account); the connector stays. */
    removeCredentials(id: number): void {
      db.delete(mcpCredentials).where(eq(mcpCredentials.serverId, id)).run();
    },

    // --- Decoded settings (never expose these in a DTO) ----------------------

    headers(row: McpServerRow): Record<string, string> {
      return decrypt<Record<string, string>>(row.headersEnc) ?? {};
    },

    clientSecret(row: McpServerRow): string | null {
      return decrypt<string>(row.oauthClientSecretEnc);
    },

    oauthConfig(row: McpServerRow): McpOauthConfig {
      try {
        const parsed: unknown = JSON.parse(row.oauthConfig);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...EMPTY_OAUTH, ...(parsed as McpOauthConfig) };
        }
      } catch {
        // Corrupt config: fall back to discovery with DCR.
      }
      return { ...EMPTY_OAUTH };
    },

    statusDetail(row: McpServerRow): McpServerStatusDetail {
      try {
        const parsed: unknown = JSON.parse(row.statusDetail);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as McpServerStatusDetail;
        }
      } catch {
        // The UI-only detail is never authoritative.
      }
      return {};
    },

    // --- OAuth credentials ---------------------------------------------------

    credentials(serverId: number): McpCredentials | null {
      const row = db.select().from(mcpCredentials).where(eq(mcpCredentials.serverId, serverId)).get();
      if (!row) return null;
      return decodeCredentials(row);
    },

    /** True when a token is stored, whether or not the current key can read it. */
    hasStoredTokens(serverId: number): boolean {
      return Boolean(
        db
          .select({ tokensEnc: mcpCredentials.tokensEnc })
          .from(mcpCredentials)
          .where(eq(mcpCredentials.serverId, serverId))
          .get()?.tokensEnc,
      );
    },

    saveCredentials(serverId: number, next: Partial<McpCredentials>): void {
      if (!secretBox) throw new SecretKeyMissingError();
      const existing = this.credentials(serverId);
      const now = new Date().toISOString();
      const values = {
        issuer: next.issuer ?? existing?.issuer ?? '',
        clientInfoEnc:
          next.clientInfo !== undefined
            ? next.clientInfo === null
              ? null
              : encrypt(next.clientInfo)
            : existing?.clientInfo
              ? encrypt(existing.clientInfo)
              : null,
        tokensEnc:
          next.tokens !== undefined
            ? next.tokens === null
              ? null
              : encrypt(next.tokens)
            : existing?.tokens
              ? encrypt(existing.tokens)
              : null,
        discoveryEnc:
          next.discovery !== undefined
            ? next.discovery === null
              ? null
              : encrypt(next.discovery)
            : existing?.discovery
              ? encrypt(existing.discovery)
              : null,
        grantedScope: next.grantedScope ?? existing?.grantedScope ?? '',
        accountLabel: next.accountLabel === undefined ? (existing?.accountLabel ?? null) : next.accountLabel,
        expiresAt: next.expiresAt === undefined ? (existing?.expiresAt ?? null) : next.expiresAt,
        updatedAt: now,
      };
      db.insert(mcpCredentials)
        .values({ serverId, ...values })
        .onConflictDoUpdate({ target: mcpCredentials.serverId, set: values })
        .run();
    },

    // --- Tools ---------------------------------------------------------------

    tools(serverId: number): McpToolRow[] {
      return db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)).orderBy(mcpTools.id).all();
    },

    allTools(): McpToolRow[] {
      return db.select().from(mcpTools).orderBy(mcpTools.id).all();
    },

    toolByExposedName(exposedName: string): McpToolRow | null {
      return db.select().from(mcpTools).where(eq(mcpTools.exposedName, exposedName)).get() ?? null;
    },

    findTool(serverId: number, name: string): McpToolRow | null {
      return (
        db
          .select()
          .from(mcpTools)
          .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)))
          .get() ?? null
      );
    },

    insertTool(serverId: number, tool: McpToolWrite, at: string): McpToolRow {
      return db
        .insert(mcpTools)
        .values({
          serverId,
          name: tool.name,
          exposedName: tool.exposedName,
          title: tool.title,
          description: tool.description,
          inputSchema: JSON.stringify(tool.inputSchema),
          annotations: JSON.stringify(tool.annotations),
          definitionHash: tool.definitionHash,
          approvedHash: tool.approvedHash,
          policy: tool.policy,
          present: true,
          firstSeenAt: at,
          lastSeenAt: at,
        })
        .returning()
        .get();
    },

    updateTool(
      id: number,
      tool: {
        name: string;
        title: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: McpToolAnnotations;
        definitionHash: string;
        policy: McpToolPolicy;
        present: boolean;
      },
      at: string,
    ): void {
      db.update(mcpTools)
        .set({
          title: tool.title,
          description: tool.description,
          inputSchema: JSON.stringify(tool.inputSchema),
          annotations: JSON.stringify(tool.annotations),
          definitionHash: tool.definitionHash,
          policy: tool.policy,
          present: tool.present,
          lastSeenAt: at,
        })
        .where(eq(mcpTools.id, id))
        .run();
    },

    setToolPolicy(id: number, policy: McpToolPolicy, approvedHash: string): void {
      db.update(mcpTools).set({ policy, approvedHash }).where(eq(mcpTools.id, id)).run();
    },

    setToolPresent(id: number, present: boolean): void {
      db.update(mcpTools).set({ present }).where(eq(mcpTools.id, id)).run();
    },
  };

  function decodeCredentials(row: McpCredentialRow): McpCredentials {
    const tokens = decrypt<McpCredentials['tokens']>(row.tokensEnc);
    const expiresAt =
      row.expiresAt ??
      (tokens && (typeof tokens.expires_at === 'number' || typeof tokens.expires_at === 'string')
        ? new Date(
            typeof tokens.expires_at === 'number'
              ? tokens.expires_at < 10_000_000_000
                ? tokens.expires_at * 1000
                : tokens.expires_at
              : tokens.expires_at,
          ).toISOString()
        : null);
    return {
      issuer: row.issuer,
      clientInfo: decrypt(row.clientInfoEnc),
      tokens,
      discovery: decrypt(row.discoveryEnc),
      grantedScope: row.grantedScope,
      accountLabel: row.accountLabel,
      expiresAt,
      updatedAt: row.updatedAt,
    };
  }
}

export type McpRepository = ReturnType<typeof createMcpRepository>;
