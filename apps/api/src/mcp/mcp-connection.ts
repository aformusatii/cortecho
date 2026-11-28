import type {
  McpAuthState,
  McpConnectionState,
  McpErrorReason,
  McpSyncReason,
  McpTransport,
} from '@cortecho/shared';
import {
  Client,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type Tool as SdkTool,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { McpServerRow } from '../db/schema.ts';
import { createLogger, errorMessage } from '../lib/logger.ts';
import type { McpRepository, McpServerCapabilities } from './mcp.repository.ts';
import { SqliteOAuthProvider } from './oauth-provider.ts';
import type { ListedTool } from './tool-mapping.ts';
import { checkAuthorizationServerUrl, checkServerUrlResolved } from './url-policy.ts';

const log = createLogger('mcp');

const CONNECT_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
/** MCP has no "instructions changed" event: refresh the handshake at this cadence. */
const RESYNC_INTERVAL_MS = 60 * 60_000;
const RESYNC_JITTER_MS = 5 * 60_000;
/** How long a manual Refresh waits for a running tool call before answering busy. */
const MANUAL_SYNC_WAIT_MS = 15_000;

/** One handshake's metadata plus (optionally) the tool list, applied as one snapshot. */
export type ServerSnapshot = {
  reason: McpSyncReason;
  syncedAt: string;
  /** Present when the sync came from a handshake (connect, manual, periodic). */
  initialize?: {
    /** Untruncated, straight from the server. */
    instructions: string | null;
    protocolVersion: string | null;
    serverName: string | null;
    serverVersion: string | null;
    capabilities: McpServerCapabilities;
  };
  /** Null = this sync did not list tools (or the list failed); keep the previous rows. */
  tools: ListedTool[] | null;
  transportUsed: McpTransport | null;
  /** A tools/list that failed on an otherwise healthy link. */
  syncError: string | null;
};

export class ConnectorBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorBusyError';
  }
}

export class ConnectorUnavailableError extends Error {
  readonly reason: McpErrorReason;

  constructor(reason: McpErrorReason, message: string) {
    super(message);
    this.name = 'ConnectorUnavailableError';
    this.reason = reason;
  }
}

export class ConnectorAuthError extends Error {
  readonly reason: 'signed-out' | 'expired' | 'insufficient-scope';

  constructor(reason: 'signed-out' | 'expired' | 'insufficient-scope', message: string) {
    super(message);
    this.name = 'ConnectorAuthError';
    this.reason = reason;
  }
}

export type McpConnectionOptions = {
  row: McpServerRow;
  repository: McpRepository;
  /** The browser-facing base URL (PUBLIC_BASE_URL, or the request origin). */
  publicBaseUrl: () => string;
  cimdEnabled: boolean;
  /** One snapshot per sync: initialize metadata and/or tools; the manager stores it. */
  onSync: (connection: McpConnection, snapshot: ServerSnapshot) => void;
  onChange: (connection: McpConnection) => void;
  /** A new OAuth flow started: state → this connector. */
  onFlow: (state: string, connection: McpConnection) => void;
};

type PendingAuth = {
  provider: SqliteOAuthProvider;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  client: Client;
};

/**
 * One connector = exactly one long-lived MCP session. Connections open at
 * startup and after a change, never during a voice turn. The manager owns one
 * of these per server row (the database is unique on slug).
 */
export class McpConnection {
  row: McpServerRow;
  state: McpConnectionState = 'disabled';
  authState: McpAuthState = 'not-required';
  reason: McpErrorReason | null = null;
  lastError: string | null = null;
  protocolVersion: string | null = null;
  transportUsed: McpTransport | null = null;
  lastConnectedAt: string | null = null;
  /** The last handshake's full note (the database keeps the capped copy). */
  instructions: string | null = null;
  serverName: string | null = null;
  serverVersion: string | null = null;
  lastSyncedAt: string | null = null;
  lastSyncReason: McpSyncReason | null = null;
  syncError: string | null = null;
  /** How many tools the last successful list returned (availability for the prompt). */
  toolCount = 0;
  /** True once the runtime tried to connect; a CLI doctor has not. */
  startedEver = false;

  private readonly options: McpConnectionOptions;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private oauthProvider: SqliteOAuthProvider | null = null;
  private pendingAuth: PendingAuth | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private started = false;
  /** The reason carried into the next handshake's snapshot. */
  private syncReason: McpSyncReason = 'connect';
  /** A running resync, so two UI clicks cannot open two links. */
  private syncing: Promise<void> | null = null;
  /** Tool calls in flight: a resync waits for them instead of closing their link. */
  private activeCalls = 0;
  /** Bumped on every stop/connect so a late async result cannot revive a link. */
  private generation = 0;

  constructor(options: McpConnectionOptions) {
    this.options = options;
    this.row = options.row;
    this.applyStoredState();
  }

  get id(): number {
    return this.row.id;
  }

  get slug(): string {
    return this.row.slug;
  }

  get name(): string {
    return this.row.name;
  }

  get connected(): boolean {
    return this.state === 'connected' && this.client !== null;
  }

  /** Reads the persisted auth state, so the UI is right before the first connect. */
  applyStoredState(): void {
    if (this.row.authType !== 'oauth') {
      this.authState = 'not-required';
    } else if (!this.options.repository.credentials(this.row.id)?.tokens) {
      this.authState = 'signed-out';
    }
  }

  /** Starts the link. Never throws: the state carries the failure. */
  async start(): Promise<void> {
    this.started = true;
    this.startedEver = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.generation += 1;
    this.clearTimers();
    await this.closeLink();
    this.state = this.row.enabled ? 'connecting' : 'disabled';
    if (!this.row.enabled) this.state = 'disabled';
    this.emit();
  }

  async reconnect(): Promise<void> {
    await this.connect('connect');
  }

  /**
   * The one refresh path. A handshake re-reads instructions, protocol version,
   * server info, capabilities and the tool list together; a second caller
   * joins the sync already running instead of opening a second link.
   */
  async resync(reason: McpSyncReason): Promise<void> {
    if (this.syncing) {
      await this.syncing.catch(() => {});
      return this.assertSynced(reason);
    }
    if (!(await this.waitForIdle(reason === 'manual' ? MANUAL_SYNC_WAIT_MS : 0))) {
      throw new ConnectorBusyError('A tool call is running; try again in a moment.');
    }
    const task = this.connect(reason);
    this.syncing = task;
    try {
      await task;
    } finally {
      if (this.syncing === task) this.syncing = null;
    }
    this.assertSynced(reason);
  }

  private assertSynced(reason: McpSyncReason): void {
    // Periodic and connect syncs carry their own state; a manual click needs a clear error.
    if (reason === 'manual' && this.state !== 'connected') {
      throw new ConnectorUnavailableError(
        this.reason ?? 'unreachable',
        this.lastError ?? 'The connector is not connected.',
      );
    }
  }

  private async waitForIdle(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.activeCalls > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  setRow(row: McpServerRow): void {
    this.row = row;
    this.oauthProvider?.setRow(row);
    this.applyStoredState();
    this.emit();
  }

  async connect(reason: McpSyncReason = 'connect'): Promise<void> {
    this.startedEver = true;
    this.syncReason = reason;
    const generation = ++this.generation;
    this.clearTimers();
    await this.closeLink();
    if (!this.row.enabled) {
      this.setState('disabled', null, null);
      return;
    }
    if (this.row.authType !== 'none' && !this.options.repository.secretKeyConfigured()) {
      this.setState('error', 'secret-key-missing', 'CORTECHO_SECRET_KEY is not set.');
      return;
    }
    const oauth = this.row.authType === 'oauth' ? this.options.repository.credentials(this.row.id) : null;
    if (this.row.authType === 'oauth' && !oauth?.tokens) {
      this.authState = 'signed-out';
      this.setState('needs_auth', null, null);
      return;
    }
    this.setState('connecting', null, null);

    const checked = await checkServerUrlResolved(this.row.url);
    if (generation !== this.generation) return;
    if (!checked.ok) {
      this.setState('error', 'url-refused', checked.message);
      return;
    }

    const transports: ('streamable-http' | 'sse')[] =
      this.row.transport === 'sse' ? ['sse'] : ['streamable-http', 'sse'];
    let lastError: unknown = null;
    for (const transportKind of transports) {
      if (generation !== this.generation) return;
      try {
        await this.openLink(transportKind, generation);
        return;
      } catch (error) {
        lastError = error;
        await this.closeLink();
        if (error instanceof UnauthorizedError || isAuthFailure(error)) {
          this.authState = 'signed-out';
          this.setState('needs_auth', null, null);
          return;
        }
        // An SSE-only server rejects the Streamable HTTP handshake: fall back once.
        if (this.row.transport === 'sse') break;
      }
    }
    if (generation !== this.generation) return;
    this.handleFailure(lastError);
    this.scheduleReconnect();
  }

  /** Runs one tool. Errors stay typed so the caller can turn them into a speakable result. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    // A call that starts while a resync is reopening the link waits for the
    // new client instead of hitting a closed one.
    if (this.syncing) await this.syncing.catch(() => {});
    if (!this.client || this.state !== 'connected') {
      throw new ConnectorUnavailableError(this.reason ?? 'unreachable', 'The connector is not connected.');
    }
    this.activeCalls += 1;
    try {
      return await this.client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    } catch (error) {
      if (error instanceof UnauthorizedError || isAuthFailure(error)) {
        this.authState = 'expired';
        this.setState('needs_auth', null, errorMessage(error));
        throw new ConnectorAuthError('expired', 'The connection needs to be signed in again.');
      }
      if (isInsufficientScope(error)) {
        this.authState = 'signed-in';
        this.setState('needs_auth', 'insufficient-scope', scopeChallenge(error));
        throw new ConnectorAuthError('insufficient-scope', 'The connection needs more permissions.');
      }
      this.setState('error', classifyError(error), errorMessage(error));
      this.scheduleReconnect();
      throw new ConnectorUnavailableError(classifyError(error), errorMessage(error));
    } finally {
      this.activeCalls -= 1;
    }
  }

  /** Begins the OAuth flow; returns the authorization URL the browser opens. */
  async startOAuth(): Promise<string> {
    if (this.row.authType !== 'oauth') throw new Error('This connector does not use OAuth.');
    if (!this.options.repository.secretKeyConfigured()) {
      throw new ConnectorUnavailableError(
        'secret-key-missing',
        'CORTECHO_SECRET_KEY is not set, so tokens cannot be stored.',
      );
    }
    const checked = await checkServerUrlResolved(this.row.url);
    if (!checked.ok) throw new ConnectorUnavailableError('url-refused', checked.message);
    await this.closeLink();
    const provider = this.newOAuthProvider();
    await this.seedDiscovery(provider);
    const transport = new StreamableHTTPClientTransport(new URL(this.row.url), {
      authProvider: provider,
      onInsufficientScope: 'throw',
      redirectPolicy: 'follow',
    });
    const client = new Client({ name: 'cortecho', version: '0.1.0' });
    this.oauthProvider = provider;
    this.pendingAuth = { provider, transport, client };
    try {
      await client.connect(transport);
      // No authorization was required after all: keep the session.
      this.pendingAuth = null;
      this.client = client;
      this.transport = transport;
      this.syncReason = 'connect';
      await this.afterConnect('streamable-http');
      throw new Error('The server did not ask for authorization.');
    } catch (error) {
      if (error instanceof UnauthorizedError || isAuthFailure(error)) {
        const url = provider.lastAuthorizationUrl;
        if (!url) throw new Error(`The authorization flow did not produce a URL: ${errorMessage(error)}`);
        this.authState = 'signed-out';
        this.setState('needs_auth', null, null);
        return url.href;
      }
      throw error;
    }
  }

  /** The browser came back: exchange the code on the transport that started the flow. */
  async finishOAuth(params: URLSearchParams): Promise<void> {
    const pending = this.pendingAuth;
    if (!pending) throw new Error('No sign-in is in progress for this connector (start it again).');
    const state = params.get('state');
    if (!state || !pending.provider.ownsState(state)) throw new Error('The sign-in state does not match.');
    try {
      await pending.transport.finishAuth(params);
    } finally {
      this.pendingAuth = null;
      await pending.client.close().catch(() => {});
    }
    this.oauthProvider = pending.provider;
    this.authState = 'signed-in';
    await this.reconnect();
  }

  /** Revokes the token when the AS supports it, then forgets the account. */
  async disconnectOAuth(): Promise<void> {
    const credentials = this.options.repository.credentials(this.row.id);
    if (credentials) await this.revoke(credentials).catch(() => {});
    this.options.repository.removeCredentials(this.row.id);
    this.authState = this.row.authType === 'oauth' ? 'signed-out' : 'not-required';
    await this.reconnect();
  }

  /** Refreshes OAuth tokens now (also called by the proactive timer). */
  async refreshAccessToken(): Promise<boolean> {
    return this.oauthProvider ? this.oauthProvider.refreshNow() : false;
  }

  private async revoke(credentials: NonNullable<ReturnType<McpRepository['credentials']>>): Promise<void> {
    const tokens = credentials.tokens;
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!token) return;
    const discovery = credentials.discovery as {
      authorizationServerMetadata?: { revocation_endpoint?: string };
    } | null;
    const endpoint = discovery?.authorizationServerMetadata?.revocation_endpoint;
    if (!endpoint) return;
    const checked = checkAuthorizationServerUrl(endpoint);
    if (!checked.ok) return;
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: tokens?.refresh_token ? 'refresh_token' : 'access_token',
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  /**
   * A connector may pin an authorization server explicitly (a server that
   * publishes no protected-resource metadata). Seed the SDK's discovery state
   * so it does not fall back to the MCP URL's own origin.
   */
  private async seedDiscovery(provider: SqliteOAuthProvider): Promise<void> {
    if (provider.discoveryState()) return;
    const config = this.options.repository.oauthConfig(this.row);
    if (!config.authorizationServer) return;
    const checked = checkAuthorizationServerUrl(config.authorizationServer);
    if (!checked.ok) return;
    try {
      const metadata = await discoverAuthorizationServerMetadata(checked.url);
      if (!metadata) return;
      const state: OAuthDiscoveryState = {
        authorizationServerUrl: checked.url.href,
        authorizationServerMetadata: metadata,
        resourceMetadata: {
          resource: this.row.url,
          authorization_servers: [checked.url.href],
        },
      };
      provider.saveDiscoveryState(state);
    } catch (error) {
      log.warn(`could not discover the configured authorization server: ${errorMessage(error)}`);
    }
  }

  private newOAuthProvider(): SqliteOAuthProvider {
    const base = this.options.publicBaseUrl();
    return new SqliteOAuthProvider({
      repository: this.options.repository,
      row: this.row,
      redirectUrl: `${base}/api/mcp/oauth/callback`,
      cimdUrl: this.options.cimdEnabled ? `${base}/api/mcp/oauth/client-metadata.json` : null,
      onState: (state) => this.options.onFlow(state, this),
    });
  }

  private async openLink(transportKind: 'streamable-http' | 'sse', generation: number): Promise<void> {
    const headers = this.row.authType === 'headers' ? this.options.repository.headers(this.row) : {};
    const provider =
      this.row.authType === 'oauth' ? (this.oauthProvider ?? this.newOAuthProvider()) : undefined;
    if (provider) {
      this.oauthProvider = provider;
      await this.seedDiscovery(provider);
    }
    const url = new URL(this.row.url);
    const transport =
      transportKind === 'sse'
        ? new SSEClientTransport(url, {
            ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
            ...(provider ? { authProvider: provider } : {}),
          })
        : new StreamableHTTPClientTransport(url, {
            ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
            ...(provider ? { authProvider: provider, redirectPolicy: 'follow' as const } : {}),
            onInsufficientScope: 'throw',
          });
    const client = new Client(
      { name: 'cortecho', version: '0.1.0' },
      {
        // The SDK registers this only when the server declares
        // `tools.listChanged`; it debounces, evicts the response cache and
        // re-lists. Tools cannot change instructions, so no reconnect.
        listChanged: {
          tools: {
            debounceMs: 300,
            onChanged: (error, tools) => {
              if (error) {
                log.debug(`tools/list_changed failed for "${this.slug}": ${errorMessage(error)}`);
                return;
              }
              if (!tools) return;
              this.applySnapshot({
                reason: 'list-changed',
                syncedAt: new Date().toISOString(),
                tools: tools.map(toListedTool),
                transportUsed: this.transportUsed,
                syncError: null,
              });
            },
          },
        },
      },
    );
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect');
    if (generation !== this.generation) {
      await client.close().catch(() => {});
      return;
    }
    this.client = client;
    this.transport = transport;
    this.pendingAuth = null;
    await this.afterConnect(transportKind);
  }

  /**
   * One snapshot per handshake: initialize metadata and the tool list land
   * together. A failed list keeps the previous tools (a transient failure
   * must not remove capabilities) but records the error.
   */
  private async afterConnect(transportKind: 'streamable-http' | 'sse'): Promise<void> {
    const client = this.client;
    if (!client) return;
    const info = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    const initialize = {
      instructions: client.getInstructions() ?? null,
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverName: info?.name ?? null,
      serverVersion: info?.version ?? null,
      capabilities: {
        tools: Boolean(capabilities?.tools),
        toolsListChanged: capabilities?.tools?.listChanged === true,
        prompts: Boolean(capabilities?.prompts),
        promptsListChanged: capabilities?.prompts?.listChanged === true,
        resources: Boolean(capabilities?.resources),
        resourcesListChanged: capabilities?.resources?.listChanged === true,
      },
    };
    this.transportUsed = transportKind;
    this.lastConnectedAt = new Date().toISOString();
    this.reconnectAttempt = 0;
    this.authState = this.row.authType === 'oauth' ? 'signed-in' : 'not-required';

    let tools: ListedTool[] | null = null;
    let syncError: string | null = null;
    try {
      // `use` can serve the SDK's cached list; a handshake must ask the server.
      const result = await client.listTools(undefined, { cacheMode: 'refresh' });
      tools = result.tools.map(toListedTool);
    } catch (error) {
      syncError = errorMessage(error);
      log.warn(`tools/list failed for "${this.slug}": ${syncError}`);
    }
    if (client !== this.client) return; // stopped or replaced while listing

    this.setState('connected', null, null);
    log.info(`connector "${this.slug}" connected over ${transportKind}`);
    this.applySnapshot({
      reason: this.syncReason,
      syncedAt: new Date().toISOString(),
      initialize,
      tools,
      transportUsed: transportKind,
      syncError,
    });
    this.schedulePing();
    this.scheduleRefresh();
    this.scheduleResync();
  }

  /** Applies one snapshot to memory, then hands the whole thing to the manager. */
  private applySnapshot(snapshot: ServerSnapshot): void {
    if (snapshot.initialize) {
      this.instructions = snapshot.initialize.instructions;
      this.protocolVersion = snapshot.initialize.protocolVersion;
      this.serverName = snapshot.initialize.serverName;
      this.serverVersion = snapshot.initialize.serverVersion;
    }
    if (snapshot.tools) this.toolCount = snapshot.tools.length;
    this.lastSyncedAt = snapshot.syncedAt;
    this.lastSyncReason = snapshot.reason;
    this.syncError = snapshot.syncError;
    try {
      this.options.onSync(this, snapshot);
    } catch (error) {
      log.warn(`could not apply a sync for "${this.slug}": ${errorMessage(error)}`);
    }
  }

  private handleFailure(error: unknown): void {
    if (error instanceof UnauthorizedError || isAuthFailure(error)) {
      this.authState = 'signed-out';
      this.setState('needs_auth', null, null);
      return;
    }
    if (isInsufficientScope(error)) {
      this.setState('needs_auth', 'insufficient-scope', scopeChallenge(error));
      return;
    }
    this.setState('error', classifyError(error), errorMessage(error));
  }

  private setState(state: McpConnectionState, reason: McpErrorReason | null, lastError: string | null): void {
    this.state = state;
    this.reason = reason;
    if (lastError !== null || state !== 'error') this.lastError = lastError;
    if (state === 'connected') {
      this.lastError = null;
      this.reason = null;
    }
    if (this.row.authType === 'oauth') {
      const credentials = this.options.repository.credentials(this.row.id);
      if (!credentials?.tokens) this.authState = 'signed-out';
      else if (this.authState !== 'expired')
        this.authState = expiresSoon(credentials.expiresAt) ? 'expiring' : 'signed-in';
    } else if (this.row.authType === 'none') {
      this.authState = 'not-required';
    }
    const current = this.options.repository.get(this.row.id);
    this.options.repository.setStatusDetail(this.row.id, {
      ...(current ? this.options.repository.statusDetail(current) : {}),
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      transportUsed: this.transportUsed,
    });
    this.emit();
  }

  private emit(): void {
    try {
      this.options.onChange(this);
    } catch (error) {
      log.debug(`connector change listener failed: ${errorMessage(error)}`);
    }
  }

  private schedulePing(): void {
    this.pingTimer = setInterval(() => {
      void (async () => {
        if (!this.client || this.state !== 'connected') return;
        try {
          await this.client.ping({ timeout: 5000 });
        } catch (error) {
          log.warn(`connector "${this.slug}" ping failed: ${errorMessage(error)}`);
          this.setState('error', 'unreachable', errorMessage(error));
          await this.closeLink();
          this.scheduleReconnect();
        }
      })();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private scheduleRefresh(): void {
    if (this.row.authType !== 'oauth' || !this.oauthProvider) return;
    const credentials = this.options.repository.credentials(this.row.id);
    const expiresAt = credentials?.expiresAt ? Date.parse(credentials.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_AHEAD_MS);
    this.refreshTimer = setTimeout(() => {
      void (async () => {
        const ok = await this.refreshAccessToken();
        if (ok) {
          this.authState = 'signed-in';
          this.setState('connected', null, null);
          this.scheduleRefresh();
        } else {
          this.authState = 'expired';
          this.setState('needs_auth', 'auth-refresh-failed', 'The token could not be refreshed.');
        }
      })();
    }, delay);
    this.refreshTimer.unref();
  }

  private scheduleReconnect(): void {
    if (!this.started || !this.row.enabled) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  /**
   * MCP has no "instructions changed" notification, so an in-place server
   * change is only visible through a new handshake. Hourly, jittered and only
   * when no tool call is running; the prompt text only changes if the server's
   * text did, so prompt caching is unaffected.
   */
  private scheduleResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    const jitter = Math.floor((Math.random() * 2 - 1) * RESYNC_JITTER_MS);
    this.resyncTimer = setTimeout(
      () => {
        this.resyncTimer = null;
        void this.periodicResync();
      },
      Math.max(60_000, RESYNC_INTERVAL_MS + jitter),
    );
    this.resyncTimer.unref();
  }

  private async periodicResync(): Promise<void> {
    if (!this.started || !this.row.enabled || this.state !== 'connected') return;
    if (this.syncing || this.activeCalls > 0) {
      this.scheduleResync();
      return;
    }
    log.debug(`connector "${this.slug}" re-syncing on the hourly schedule`);
    try {
      await this.resync('periodic');
    } catch (error) {
      log.debug(`periodic resync failed for "${this.slug}": ${errorMessage(error)}`);
      this.scheduleResync();
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.pingTimer = null;
    this.refreshTimer = null;
    this.reconnectTimer = null;
    this.resyncTimer = null;
  }

  private async closeLink(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
  }
}

function toListedTool(tool: SdkTool): ListedTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: (tool.annotations ?? {}) as ListedTool['annotations'],
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      timer.unref();
      void promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

function isAuthFailure(error: unknown): boolean {
  const status = (error as { status?: number; code?: string } | null)?.status;
  if (status === 401 || status === 403) return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes('401') || message.includes('unauthorized') || message.includes('invalid_grant');
}

function isInsufficientScope(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = errorMessage(error).toLowerCase();
  return name.includes('InsufficientScope') || message.includes('insufficient_scope');
}

function scopeChallenge(error: unknown): string {
  const message = errorMessage(error);
  return message.slice(0, 1000);
}

function classifyError(error: unknown): McpErrorReason {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('scheme') || message.includes('url') || message.includes('resolve'))
    return 'url-refused';
  if (message.includes('unauthorized') || message.includes('401')) return 'auth-refresh-failed';
  return 'protocol';
}

function expiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - Date.now() < REFRESH_AHEAD_MS;
}

/** Kept for the manager: the provider type is only used inside this module. */
export type { OAuthClientProvider };
