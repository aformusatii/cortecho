import type {
  McpAuthState,
  McpConnectionState,
  McpServerDetail,
  McpServerStatus,
  McpToolAnnotations,
  McpToolStatus,
} from '@cortecho/shared';
import type { McpServerRow, McpToolRow } from '../../db/schema.ts';
import type { McpManager } from '../../mcp/mcp-manager.ts';
import { effectivePolicy, reviewReason } from '../../mcp/mcp-manager.ts';

type Annotations = McpToolAnnotations;

/** The list/sheet DTO. Secrets are absent by construction: the row's encrypted columns never leave. */
export function toServerStatus(manager: McpManager, row: McpServerRow): McpServerStatus {
  const connection = manager.connection(row.id);
  const detail = manager.repository.statusDetail(row);
  const credentials = manager.repository.credentials(row.id);
  const tools = manager.repository.tools(row.id);
  const present = tools.filter((tool) => tool.present);
  const toolsEnabled = present.filter((tool) => effectivePolicy(tool) !== 'off').length;
  const needsReview = present.filter((tool) => reviewReason(tool) !== null).length;
  const authState = authStateOf(
    row,
    connection?.authState ?? null,
    credentials?.expiresAt ?? null,
    Boolean(credentials?.tokens),
  );
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    catalogId: row.catalogId,
    transport: row.transport,
    transportUsed:
      (detail.transportUsed as McpServerStatus['transportUsed']) ?? connection?.transportUsed ?? null,
    url: row.url,
    enabled: row.enabled,
    description: row.description,
    authType: row.authType,
    hasHeaders: Boolean(row.headersEnc),
    hasClientSecret: Boolean(row.oauthClientSecretEnc),
    oauthConfig: manager.repository.oauthConfig(row),
    timeoutMs: row.timeoutMs,
    maxResultChars: row.maxResultChars,
    useServerInstructions: row.useServerInstructions,
    state: stateOf(row, connection?.state ?? null),
    authState,
    reason: connection?.reason ?? null,
    lastError: detail.lastError ?? connection?.lastError ?? null,
    lastConnectedAt: detail.lastConnectedAt ?? connection?.lastConnectedAt ?? null,
    protocolVersion: detail.protocolVersion ?? connection?.protocolVersion ?? null,
    serverInstructions: detail.serverInstructions ?? connection?.instructions ?? null,
    accountLabel: credentials?.accountLabel ?? null,
    grantedScope: credentials?.grantedScope || null,
    expiresAt: credentials?.expiresAt ?? null,
    toolsEnabled,
    toolsTotal: present.length,
    needsReview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toServerDetail(manager: McpManager, row: McpServerRow): McpServerDetail {
  return {
    ...toServerStatus(manager, row),
    tools: manager.repository.tools(row.id).map(toToolStatus),
  };
}

export function toToolStatus(tool: McpToolRow): McpToolStatus {
  return {
    id: tool.id,
    name: tool.name,
    exposedName: tool.exposedName,
    title: tool.title,
    description: tool.description,
    inputSchema: parseJson<Record<string, unknown>>(tool.inputSchema, {}),
    annotations: normalizeAnnotations(tool.annotations),
    policy: tool.policy,
    present: tool.present,
    review: reviewReason(tool),
    firstSeenAt: tool.firstSeenAt,
    lastSeenAt: tool.lastSeenAt,
  };
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeAnnotations(raw: string): Annotations {
  const parsed = parseJson<Annotations>(raw, {});
  return {
    ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
    ...(typeof parsed.readOnlyHint === 'boolean' ? { readOnlyHint: parsed.readOnlyHint } : {}),
    ...(typeof parsed.destructiveHint === 'boolean' ? { destructiveHint: parsed.destructiveHint } : {}),
    ...(typeof parsed.idempotentHint === 'boolean' ? { idempotentHint: parsed.idempotentHint } : {}),
    ...(typeof parsed.openWorldHint === 'boolean' ? { openWorldHint: parsed.openWorldHint } : {}),
  };
}

function stateOf(row: McpServerRow, connectionState: McpConnectionState | null): McpConnectionState {
  if (!row.enabled) return 'disabled';
  return connectionState ?? 'connecting';
}

function authStateOf(
  row: McpServerRow,
  connectionAuth: McpAuthState | null,
  expiresAt: string | null,
  hasTokens: boolean,
): McpAuthState {
  if (row.authType === 'none') return 'not-required';
  if (row.authType === 'headers') return 'not-required';
  if (!hasTokens) return 'signed-out';
  if (connectionAuth) return connectionAuth;
  if (expiresAt) {
    const at = Date.parse(expiresAt);
    if (Number.isFinite(at) && at <= Date.now()) return 'expired';
    if (Number.isFinite(at) && at - Date.now() < 5 * 60_000) return 'expiring';
  }
  return 'signed-in';
}
