import { z } from 'zod';

// ---------------------------------------------------------------------------
// The contract for connectors (MCP servers): CRUD, tools, policies and the
// runtime state the Connectors UI shows. Secrets are write-only: no response
// type in this file can carry a token, a header value or a client secret.
// ---------------------------------------------------------------------------

export const MCP_TRANSPORTS = ['streamable-http', 'sse', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_AUTH_TYPES = ['none', 'headers', 'oauth'] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

export const MCP_TOOL_POLICIES = ['off', 'auto', 'confirm'] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** The link state of one connector. `disabled` wins over every other state. */
export const MCP_CONNECTION_STATES = ['disabled', 'connecting', 'connected', 'needs_auth', 'error'] as const;
export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];

export const MCP_AUTH_STATES = ['not-required', 'signed-out', 'signed-in', 'expiring', 'expired'] as const;
export type McpAuthState = (typeof MCP_AUTH_STATES)[number];

export const MCP_ERROR_REASONS = [
  'unreachable',
  'timeout',
  'protocol',
  'url-refused',
  'secret-key-missing',
  'auth-refresh-failed',
  'insufficient-scope',
] as const;
export type McpErrorReason = (typeof MCP_ERROR_REASONS)[number];

export const MCP_TOOL_REVIEW_REASONS = ['new', 'changed'] as const;
export type McpToolReviewReason = (typeof MCP_TOOL_REVIEW_REASONS)[number];

/** Tool annotations are hints from the server, never trusted on their own. */
export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpOauthConfig = {
  /** `auto` = CIMD/DCR through discovery; `preregistered` = the owner's client. */
  registration: 'auto' | 'preregistered';
  clientId?: string;
  /** Catalog scopes override the server's challenge/metadata scopes. */
  scopes?: string[];
  extraAuthParams?: Record<string, string>;
  /** When a server publishes no protected-resource metadata. */
  authorizationServer?: string;
  /** Some authorization servers reject RFC 8707's `resource` parameter. */
  sendResource?: boolean;
};

export type McpOauthConfigInput = z.input<typeof mcpOauthConfigSchema>;

/** One HTTP header the owner configured; values never leave the server after saving. */
export const mcpHeadersSchema = z.record(z.string().trim().min(1).max(100), z.string().min(1).max(4000));

export const mcpOauthConfigSchema = z.object({
  registration: z.enum(['auto', 'preregistered']).default('auto'),
  clientId: z.string().trim().min(1).max(300).optional(),
  scopes: z.array(z.string().trim().min(1).max(300)).max(40).optional(),
  extraAuthParams: z.record(z.string().max(100), z.string().max(1000)).optional(),
  authorizationServer: z.string().trim().url().max(500).optional(),
  sendResource: z.boolean().optional(),
});

export const MCP_SLUG_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

const slugField = z
  .string()
  .trim()
  .regex(MCP_SLUG_PATTERN, 'Use 2 to 16 lowercase letters and digits, starting with a letter.');

const nameField = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');
const urlField = z.string().trim().min(1, 'Enter the server URL.').max(500);

const timeoutField = z.number().int().min(500).max(20_000);
const resultCharsField = z.number().int().min(500).max(16_000);

export const mcpServerCreateSchema = z
  .object({
    name: nameField,
    slug: slugField,
    catalogId: z.string().trim().max(80).optional(),
    transport: z.enum(MCP_TRANSPORTS).default('streamable-http'),
    url: urlField,
    enabled: z.boolean().default(true),
    description: z.string().trim().max(300).default(''),
    authType: z.enum(MCP_AUTH_TYPES).default('none'),
    /** Write-only. */
    headers: mcpHeadersSchema.optional(),
    oauthConfig: mcpOauthConfigSchema.optional(),
    /** Write-only. */
    clientSecret: z.string().max(4000).optional(),
    timeoutMs: timeoutField.default(10_000),
    maxResultChars: resultCharsField.default(4000),
    useServerInstructions: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    if (body.transport === 'stdio') {
      ctx.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'stdio servers are environment-only and cannot be added here.',
      });
    }
    if (body.authType === 'headers' && Object.keys(body.headers ?? {}).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['headers'], message: 'Add at least one header.' });
    }
    if (body.authType === 'oauth' && body.oauthConfig?.registration === 'preregistered') {
      if (!body.oauthConfig.clientId)
        ctx.addIssue({ code: 'custom', path: ['oauthConfig.clientId'], message: 'Enter the client ID.' });
      if (!body.clientSecret)
        ctx.addIssue({
          code: 'custom',
          path: ['clientSecret'],
          message: 'Enter the client secret.',
        });
    }
  });
export type McpServerCreate = z.input<typeof mcpServerCreateSchema>;

/** Every field optional. `headers: null` clears them; absent keeps them. */
export const mcpServerUpdateSchema = z
  .object({
    name: nameField.optional(),
    catalogId: z.string().trim().max(80).nullable().optional(),
    transport: z.enum(MCP_TRANSPORTS).optional(),
    url: urlField.optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().max(300).optional(),
    authType: z.enum(MCP_AUTH_TYPES).optional(),
    headers: mcpHeadersSchema.nullable().optional(),
    oauthConfig: mcpOauthConfigSchema.nullable().optional(),
    clientSecret: z.string().max(4000).nullable().optional(),
    timeoutMs: timeoutField.optional(),
    maxResultChars: resultCharsField.optional(),
    useServerInstructions: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.transport === 'stdio') {
      ctx.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'stdio servers are environment-only and cannot be changed here.',
      });
    }
  });
export type McpServerUpdate = z.infer<typeof mcpServerUpdateSchema>;

export const mcpToolPolicyPatchSchema = z.object({
  /** Optional settings-style version; connectors are not part of that document. */
  version: z.number().int().min(0).optional(),
  policies: z.record(z.string(), z.enum(MCP_TOOL_POLICIES)),
});
export type McpToolPolicyPatch = z.infer<typeof mcpToolPolicyPatchSchema>;

export const mcpToolTrySchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** Write tools need an explicit confirmation in the body. */
  confirm: z.boolean().default(false),
});
export type McpToolTry = z.infer<typeof mcpToolTrySchema>;

export const mcpOauthCompleteSchema = z.object({
  callbackUrl: z.string().trim().min(1).max(4000),
});
export type McpOauthComplete = z.infer<typeof mcpOauthCompleteSchema>;

export const mcpOauthStartResponseSchema = z.object({
  authorizationUrl: z.string(),
});
export type McpOauthStartResponse = z.infer<typeof mcpOauthStartResponseSchema>;

/** One tool as the UI sees it. `inputSchema` is the server's JSON Schema. */
export type McpToolStatus = {
  id: number;
  name: string;
  exposedName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  policy: McpToolPolicy;
  /** False when the server no longer lists it (kept for history and policy). */
  present: boolean;
  /** `new` = never approved; `changed` = the definition differs from the approval. */
  review: McpToolReviewReason | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** One connector as the list and the sheet show it. No secret ever appears here. */
export type McpServerStatus = {
  id: number;
  slug: string;
  name: string;
  catalogId: string | null;
  transport: McpTransport;
  /** The transport that actually worked, when the connection is up. */
  transportUsed: McpTransport | null;
  url: string;
  enabled: boolean;
  description: string;
  authType: McpAuthType;
  hasHeaders: boolean;
  hasClientSecret: boolean;
  oauthConfig: McpOauthConfig;
  timeoutMs: number;
  maxResultChars: number;
  useServerInstructions: boolean;
  state: McpConnectionState;
  authState: McpAuthState;
  /** Why the link is in `error` (or needs auth). */
  reason: McpErrorReason | null;
  lastError: string | null;
  lastConnectedAt: string | null;
  protocolVersion: string | null;
  /** The server's `instructions` from initialize (shown by the Prompt tab). */
  serverInstructions: string | null;
  /** OAuth identity, when the AS/a userinfo response provided it. */
  accountLabel: string | null;
  grantedScope: string | null;
  expiresAt: string | null;
  toolsEnabled: number;
  toolsTotal: number;
  needsReview: number;
  createdAt: string;
  updatedAt: string;
};

export type McpServerDetail = McpServerStatus & {
  tools: McpToolStatus[];
};

export type McpCatalogEntry = {
  id: string;
  label: string;
  vendor: string;
  status: 'stable' | 'preview' | 'community';
  suggestedSlug: string;
  url?: string;
  urlHint?: string;
  transport: 'streamable-http' | 'sse';
  auth:
    | { type: 'none' }
    | { type: 'headers'; fields: { header: string; label: string; prefix?: string }[] }
    | {
        type: 'oauth';
        registration: 'auto' | 'preregistered';
        scopes?: string[];
        extraAuthParams?: Record<string, string>;
        authorizationServer?: string;
        sendResource?: boolean;
      };
  defaultDescription: string;
  defaultPolicies?: Record<string, McpToolPolicy>;
  guideAnchor: string;
};

/** The small shape /api/health exposes for every connector. */
export type McpHealthEntry = {
  slug: string;
  state: McpConnectionState;
  authState: McpAuthState;
};
