import type { McpHealthEntry, McpSyncReason, McpToolPolicy, Settings } from '@cortecho/shared';
import { MAX_SERVER_INSTRUCTIONS_CHARS } from '@cortecho/shared';
import type { McpServerRow, McpToolRow } from '../db/schema.ts';
import { createLogger, errorMessage } from '../lib/logger.ts';
import type { ConnectorPromptLine } from '../tools/registry.ts';
import type { McpRepository, McpServerStatusDetail } from './mcp.repository.ts';
import { McpConnection, type ServerSnapshot } from './mcp-connection.ts';
import {
  definitionHash,
  exposedToolName,
  type ListedTool,
  sanitizeInputSchema,
  storedDescription,
  storedTitle,
} from './tool-mapping.ts';

const log = createLogger('mcp');

const FLOW_TTL_MS = 10 * 60_000;

/** The policy that actually applies: a changed/new definition is off until approved. */
export function effectivePolicy(tool: McpToolRow): McpToolPolicy {
  if (!tool.present) return 'off';
  if (!tool.approvedHash || tool.approvedHash !== tool.definitionHash) return 'off';
  return tool.policy;
}

export function reviewReason(tool: McpToolRow): 'new' | 'changed' | null {
  if (!tool.present) return null;
  if (!tool.approvedHash) return 'new';
  if (tool.approvedHash !== tool.definitionHash) return 'changed';
  return null;
}

export type McpManagerOptions = {
  repository: McpRepository;
  /** PUBLIC_BASE_URL, or empty when the env var is unset. */
  publicBaseUrl: () => string;
  cimdEnabled: boolean;
  onChange?: () => void;
};

/**
 * Owns one `McpConnection` per server row and keeps the tool table in sync.
 * Exactly one connection per row: never a second client for the same URL.
 */
export class McpManager {
  readonly repository: McpRepository;
  private readonly options: McpManagerOptions;
  private readonly connections = new Map<number, McpConnection>();
  private readonly flows = new Map<string, { serverId: number; createdAt: number }>();
  /** The request origin, used when PUBLIC_BASE_URL is empty (local development). */
  private requestBaseUrl: string | null = null;

  constructor(options: McpManagerOptions) {
    this.options = options;
    this.repository = options.repository;
    for (const row of options.repository.list()) {
      this.connections.set(row.id, this.createConnection(row));
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.start()));
  }

  /** The OAuth routes hand the browser's origin in when PUBLIC_BASE_URL is unset. */
  setPublicBaseUrl(url: string): void {
    this.requestBaseUrl = url.replace(/\/+$/, '');
  }

  baseUrl(): string {
    return (this.options.publicBaseUrl() || this.requestBaseUrl || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.stop()));
  }

  list(): McpConnection[] {
    return [...this.connections.values()].sort((a, b) => a.id - b.id);
  }

  rows(): McpServerRow[] {
    return this.repository.list();
  }

  connection(id: number): McpConnection | null {
    return this.connections.get(id) ?? null;
  }

  connectionBySlug(slug: string): McpConnection | null {
    return this.list().find((connection) => connection.slug === slug) ?? null;
  }

  async add(row: McpServerRow): Promise<McpConnection> {
    const connection = this.createConnection(row);
    this.connections.set(row.id, connection);
    if (row.enabled) await connection.start();
    return connection;
  }

  async update(before: McpServerRow, after: McpServerRow): Promise<void> {
    const connection = this.connections.get(after.id) ?? this.createConnection(after);
    this.connections.set(after.id, connection);
    const linkChanged =
      before.url !== after.url ||
      before.transport !== after.transport ||
      before.authType !== after.authType ||
      before.enabled !== after.enabled ||
      before.headersEnc !== after.headersEnc ||
      before.oauthConfig !== after.oauthConfig ||
      before.oauthClientSecretEnc !== after.oauthClientSecretEnc;
    connection.setRow(after);
    if (!after.enabled) await connection.stop();
    else if (linkChanged) await connection.reconnect();
    else if (!connection.startedEver || connection.state === 'disabled') await connection.start();
  }

  async remove(id: number): Promise<void> {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (connection) await connection.stop();
    for (const [state, flow] of this.flows) {
      if (flow.serverId === id) this.flows.delete(state);
    }
  }

  async reconnect(id: number): Promise<void> {
    await this.connections.get(id)?.reconnect();
  }

  /** The one sync entry: a handshake refreshes everything, list_changed only tools. */
  async resync(id: number, reason: McpSyncReason = 'manual'): Promise<void> {
    await this.connections.get(id)?.resync(reason);
  }

  /** The OAuth flow's callback lookup; expired flows are ignored. */
  flowServer(state: string): number | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
      this.flows.delete(state);
      return null;
    }
    return flow.serverId;
  }

  finishFlow(state: string): void {
    this.flows.delete(state);
  }

  health(): McpHealthEntry[] {
    return this.list().map((connection) => ({
      slug: connection.slug,
      state: connection.state,
      authState: connection.authState,
    }));
  }

  /** Enabled connectors for the prompt, with their availability for this turn. */
  describe(deviceId: number | null, settings: Settings): ConnectorPromptLine[] {
    void deviceId;
    const disabled = new Set(settings.connectors.disabled);
    return this.list()
      .filter((connection) => connection.row.enabled && !disabled.has(connection.slug))
      .map((connection) => {
        const fresh = this.repository.get(connection.id) ?? connection.row;
        const detail = this.repository.statusDetail(fresh);
        return {
          slug: connection.slug,
          name: connection.name,
          description: connection.row.description,
          available: connection.state === 'connected' && connection.toolCount > 0,
          ...(connection.row.useServerInstructions && detail.serverInstructions
            ? { instructions: detail.serverInstructions.slice(0, MAX_SERVER_INSTRUCTIONS_CHARS) }
            : {}),
        };
      });
  }

  /** Rows whose tools may be offered (connected, enabled, not disabled for this Echo). */
  offeredRows(
    deviceId: number | null,
    settings: Settings,
  ): { row: McpServerRow; connection: McpConnection }[] {
    void deviceId;
    const disabled = new Set(settings.connectors.disabled);
    return this.list()
      .filter(
        (connection) =>
          connection.row.enabled && !disabled.has(connection.slug) && connection.state === 'connected',
      )
      .map((connection) => ({ row: connection.row, connection }));
  }

  /**
   * Applies one snapshot: the tool list (if it carries one) and the initialize
   * metadata land together, synchronously, so a turn cannot read half a sync.
   *
   * Tool rules are unchanged: the first sync gives read-only tools `auto` and
   * everything else `confirm`; a tool that appears later is `off` until the
   * owner reviews it; a changed definition keeps its old approval hash, so it
   * is effectively off until approved.
   */
  applySync(connection: McpConnection, snapshot: ServerSnapshot): void {
    try {
      const serverId = connection.id;
      const freshRow = this.repository.get(serverId) ?? connection.row;
      const before = this.repository.statusDetail(freshRow);
      const at = snapshot.syncedAt;
      const counts = snapshot.tools ? this.syncTools(connection, snapshot.tools) : null;
      const detail: McpServerStatusDetail = {
        ...before,
        lastSyncedAt: at,
        lastSyncReason: snapshot.reason,
        syncError: snapshot.syncError,
        ...(snapshot.tools ? { toolsSyncedAt: before.toolsSyncedAt ?? at } : {}),
      };

      const changes: string[] = [];
      if (counts) {
        const material = counts.added + counts.changed + counts.gone > 0;
        // A repeated list with the same tools is not a change; the first sync is.
        if (material || !before.toolsSyncedAt) {
          const suffix = [
            counts.added > 0 ? `${counts.added} new` : '',
            counts.changed > 0 ? `${counts.changed} changed` : '',
            counts.gone > 0 ? `${counts.gone} gone` : '',
          ]
            .filter(Boolean)
            .join(', ');
          changes.push(`${counts.listed} tool(s)${suffix ? ` (${suffix})` : ''}`);
        }
      }

      if (snapshot.initialize) {
        const init = snapshot.initialize;
        const cut = init.instructions?.slice(0, MAX_SERVER_INSTRUCTIONS_CHARS) ?? null;
        const length = init.instructions?.length ?? null;
        const instructionsChanged =
          (before.serverInstructions ?? null) !== cut || (before.serverInstructionsLength ?? null) !== length;
        if (instructionsChanged) {
          changes.push(
            `instructions ${before.serverInstructionsLength ?? 'none'}→${length ?? 'none'} characters` +
              (length !== null && length > MAX_SERVER_INSTRUCTIONS_CHARS
                ? ` (cut at ${MAX_SERVER_INSTRUCTIONS_CHARS})`
                : ''),
          );
        }
        if ((before.protocolVersion ?? null) !== init.protocolVersion) {
          changes.push(
            `protocol ${before.protocolVersion ?? 'unknown'}→${init.protocolVersion ?? 'unknown'}`,
          );
        }
        if (
          (before.serverName ?? null) !== init.serverName ||
          (before.serverVersion ?? null) !== init.serverVersion
        ) {
          changes.push(
            `serverInfo ${before.serverName ?? 'unknown'} ${before.serverVersion ?? ''}→${init.serverName ?? 'unknown'} ${init.serverVersion ?? ''}`.trim(),
          );
        }
        detail.serverInstructions = cut;
        detail.serverInstructionsLength = length;
        detail.protocolVersion = init.protocolVersion;
        detail.serverName = init.serverName;
        detail.serverVersion = init.serverVersion;
        detail.serverCapabilities = init.capabilities;
      }

      const syncErrorChanged = (before.syncError ?? null) !== (snapshot.syncError ?? null);
      if (syncErrorChanged) changes.push(snapshot.syncError ? 'tool list failed' : 'tool list recovered');
      if (changes.length > 0) {
        this.repository.setStatusDetail(serverId, detail);
        log.info(`connector "${connection.slug}" synced (${snapshot.reason}): ${changes.join(', ')}`);
        this.options.onChange?.();
      } else {
        // Nothing prompt-bearing changed: keep the timestamp in memory only, so
        // the stored text (and OpenAI's cached prefix) is not rewritten.
        log.debug(`connector "${connection.slug}" synced (${snapshot.reason}): no change`);
      }
    } catch (error) {
      log.warn(`could not store a sync for "${connection.slug}": ${errorMessage(error)}`);
    }
  }

  /** Writes the tool table for one list; the caller logs the counts. */
  private syncTools(
    connection: McpConnection,
    listed: ListedTool[],
  ): { listed: number; added: number; changed: number; gone: number } {
    const serverId = connection.id;
    const existing = this.repository.tools(serverId);
    const freshRow = this.repository.get(serverId) ?? connection.row;
    const detailBefore = this.repository.statusDetail(freshRow);
    const firstSync = !detailBefore.toolsSyncedAt;
    const byName = new Map(existing.map((tool) => [tool.name, tool]));
    const seenNames = new Set<string>();
    const takenExposed = new Set(
      this.repository
        .allTools()
        .filter((tool) => tool.serverId !== serverId)
        .map((tool) => tool.exposedName),
    );
    for (const tool of existing) takenExposed.add(tool.exposedName);
    const at = new Date().toISOString();
    let added = 0;
    let changed = 0;
    let gone = 0;

    for (const item of listed) {
      seenNames.add(item.name);
      const sanitized = sanitizeInputSchema(item.inputSchema);
      const annotations = item.annotations ?? {};
      const hash = definitionHash(item, sanitized.schema, annotations);
      const current = byName.get(item.name);
      if (!current) {
        const policy: McpToolPolicy = firstSync
          ? annotations.readOnlyHint === true && annotations.destructiveHint !== true
            ? 'auto'
            : 'confirm'
          : 'off';
        const exposedName = exposedToolName(connection.slug, item.name, takenExposed);
        takenExposed.add(exposedName);
        this.repository.insertTool(
          serverId,
          {
            name: item.name,
            exposedName,
            title: storedTitle(item),
            description: storedDescription(item),
            inputSchema: sanitized.schema,
            annotations,
            definitionHash: hash,
            approvedHash: firstSync && !sanitized.tooLarge ? hash : null,
            policy: sanitized.tooLarge ? 'off' : policy,
          },
          at,
        );
        added += 1;
        continue;
      }
      if (current.definitionHash !== hash) changed += 1;
      const policy: McpToolPolicy = sanitized.tooLarge ? 'off' : current.policy;
      this.repository.updateTool(
        current.id,
        {
          name: item.name,
          title: storedTitle(item),
          description: storedDescription(item),
          inputSchema: sanitized.schema,
          annotations,
          definitionHash: hash,
          policy,
          present: true,
        },
        at,
      );
    }

    for (const tool of existing) {
      if (!seenNames.has(tool.name) && tool.present) {
        this.repository.setToolPresent(tool.id, false);
        gone += 1;
      }
    }
    return { listed: listed.length, added, changed, gone };
  }

  private createConnection(row: McpServerRow): McpConnection {
    return new McpConnection({
      row,
      repository: this.repository,
      publicBaseUrl: () => this.baseUrl(),
      cimdEnabled: this.options.cimdEnabled,
      onSync: (connection, snapshot) => this.applySync(connection, snapshot),
      onChange: () => this.options.onChange?.(),
      onFlow: (state, connection) => {
        this.flows.set(state, { serverId: connection.id, createdAt: Date.now() });
      },
    });
  }
}
