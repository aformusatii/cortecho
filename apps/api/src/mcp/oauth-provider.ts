import type { McpOauthConfig } from '@cortecho/shared';
import {
  checkResourceAllowed,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  refreshAuthorization,
  resourceUrlFromServerUrl,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { McpServerRow } from '../db/schema.ts';
import { createLogger, errorMessage } from '../lib/logger.ts';
import type { McpCredentials, McpRepository } from './mcp.repository.ts';
import { checkAuthorizationServerUrl } from './url-policy.ts';

const log = createLogger('mcp-oauth');

type Tokens = OAuthTokens & { expires_in?: number; expires_at?: number; scope?: string; id_token?: string };

/**
 * The SDK's OAuth storage surface, backed by `mcp_credentials`. Tokens, client
 * registrations and discovery state are encrypted by the repository; the PKCE
 * verifier and the `state` live in memory for the ten minutes of one flow.
 */
export class SqliteOAuthProvider implements OAuthClientProvider {
  private readonly repository: McpRepository;
  private row: McpServerRow;
  private readonly redirect: string;
  private readonly cimdUrl: string | null;
  private verifier: string | null = null;
  private discovery: OAuthDiscoveryState | null = null;
  private stateValue: string | null = null;
  /** Captured by redirectToAuthorization; the start route returns it. */
  lastAuthorizationUrl: URL | null = null;
  private readonly onState: ((state: string) => void) | undefined;

  constructor({
    repository,
    row,
    redirectUrl,
    cimdUrl,
    onState,
  }: {
    repository: McpRepository;
    row: McpServerRow;
    redirectUrl: string;
    cimdUrl?: string | null;
    onState?: (state: string) => void;
  }) {
    this.repository = repository;
    this.row = row;
    this.redirect = redirectUrl;
    this.cimdUrl = cimdUrl ?? null;
    this.onState = onState;
    const stored = repository.credentials(row.id);
    this.discovery = (stored?.discovery as OAuthDiscoveryState | null) ?? null;
  }

  setRow(row: McpServerRow): void {
    this.row = row;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadataUrl(): string | undefined {
    return this.cimdUrl ?? undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    const config = this.config();
    return {
      client_name: 'Cortecho',
      redirect_uris: [this.redirect],
      // The UI opens the flow in a browser tab and comes back to a public URL.
      application_type:
        this.redirect.startsWith('http://localhost') || this.redirect.includes('127.0.0.1')
          ? 'native'
          : 'web',
      ...(config.scopes && config.scopes.length > 0 ? { scope: config.scopes.join(' ') } : {}),
    };
  }

  state(): string {
    const state = crypto.randomUUID();
    this.stateValue = state;
    this.onState?.(state);
    return state;
  }

  ownsState(state: string): boolean {
    return this.stateValue === state;
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const config = this.config();
    // A pre-registered client is the owner's Google Cloud app: always present,
    // never overwritten by a dynamic registration.
    if (config.registration === 'preregistered' && config.clientId) {
      const secret = this.repository.clientSecret(this.row);
      return {
        client_id: config.clientId,
        ...(secret ? { client_secret: secret } : {}),
        token_endpoint_auth_method: secret ? 'client_secret_basic' : 'none',
        ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
      } as StoredOAuthClientInformation;
    }
    const stored = this.repository.credentials(this.row.id)?.clientInfo as
      | (StoredOAuthClientInformation & { issuer?: string })
      | null;
    if (!stored) return undefined;
    if (ctx?.issuer && stored.issuer && stored.issuer !== ctx.issuer) return undefined;
    return stored;
  }

  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    this.repository.saveCredentials(this.row.id, {
      issuer: ctx?.issuer ?? this.credentials()?.issuer ?? '',
      clientInfo: { ...info, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) },
    });
  }

  tokens(): StoredOAuthTokens | undefined {
    const tokens = this.credentials()?.tokens as StoredOAuthTokens | null | undefined;
    return tokens ?? undefined;
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const value = tokens as Tokens;
    const expiresAt = expiryOf(value);
    const accountLabel = accountLabelOf(value);
    this.repository.saveCredentials(this.row.id, {
      issuer: ctx?.issuer ?? this.credentials()?.issuer ?? '',
      tokens: value as McpCredentials['tokens'],
      grantedScope: value.scope ?? '',
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      ...(accountLabel ? { accountLabel } : {}),
    });
    log.info(`tokens saved for "${this.row.slug}"`, {
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE verifier for this flow (start the sign-in again).');
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
    this.repository.saveCredentials(this.row.id, { discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery ?? undefined;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this.verifier = null;
      return;
    }
    if (scope === 'all') {
      this.repository.removeCredentials(this.row.id);
      this.discovery = null;
      return;
    }
    const current = this.credentials();
    this.repository.saveCredentials(this.row.id, {
      ...(scope === 'client' ? { clientInfo: null } : {}),
      ...(scope === 'tokens' ? { tokens: null, expiresAt: null, grantedScope: '' } : {}),
      ...(scope === 'discovery' ? { discovery: null } : {}),
    });
    if (scope === 'discovery') this.discovery = null;
    if (current) this.row = { ...this.row };
  }

  /**
   * Applies the catalog's quirks before the browser sees the URL:
   * - explicit scopes override whatever the SDK discovered;
   * - extraAuthParams (Google's access_type/prompt) are added.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    const config = this.config();
    const url = new URL(authorizationUrl);
    if (config.scopes && config.scopes.length > 0) {
      url.searchParams.set('scope', config.scopes.join(' '));
    }
    for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
      url.searchParams.set(key, value);
    }
    this.lastAuthorizationUrl = url;
  }

  /**
   * RFC 8707: send the server's own URL as `resource`; `sendResource: false`
   * is the documented quirk for an AS that rejects it.
   */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    const config = this.config();
    if (config.sendResource === false) return undefined;
    const expected = resourceUrlFromServerUrl(String(serverUrl));
    if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) {
      throw new Error(`The server asked for a different resource (${resource}) than ${expected.href}.`);
    }
    return expected;
  }

  /** The proactive refresh, five minutes before expiry (the transport's 401 is the safety net). */
  async refreshNow(): Promise<boolean> {
    const credentials = this.credentials();
    const tokens = credentials?.tokens as Tokens | null;
    if (!tokens?.refresh_token) return false;
    const discovery = (credentials?.discovery as OAuthDiscoveryState | null) ?? this.discovery;
    const config = this.config();
    try {
      const issuer = config.authorizationServer ?? discovery?.authorizationServerUrl ?? credentials?.issuer;
      if (!issuer) return false;
      const checked = checkAuthorizationServerUrl(issuer);
      if (!checked.ok) {
        log.warn(`refresh refused: ${checked.message}`);
        return false;
      }
      const clientInformation = this.clientInformation({ issuer });
      if (!clientInformation) return false;
      const next = await refreshAuthorization(issuer, {
        metadata: discovery?.authorizationServerMetadata,
        clientInformation,
        refreshToken: tokens.refresh_token,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        ...(config.sendResource === false ? {} : { resource: resourceUrlFromServerUrl(this.row.url).href }),
      });
      this.saveTokens(next as StoredOAuthTokens, { issuer });
      return true;
    } catch (error) {
      log.warn(`proactive token refresh failed for "${this.row.slug}": ${errorMessage(error)}`);
      return false;
    }
  }

  private config(): McpOauthConfig {
    return this.repository.oauthConfig(this.row);
  }

  private credentials(): McpCredentials | null {
    return this.repository.credentials(this.row.id);
  }
}

function expiryOf(tokens: Tokens): number | null {
  if (typeof tokens.expires_at === 'number' && Number.isFinite(tokens.expires_at)) {
    return tokens.expires_at < 10_000_000_000 ? tokens.expires_at * 1000 : tokens.expires_at;
  }
  if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
    return Date.now() + tokens.expires_in * 1000;
  }
  return null;
}

/** Best effort: an id_token's email/name for the Account tab; never verified or trusted. */
function accountLabelOf(tokens: Tokens): string | null {
  if (typeof tokens.id_token !== 'string') return null;
  try {
    const payload = tokens.id_token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const label = json.email ?? json.preferred_username ?? json.name;
    return typeof label === 'string' ? label.slice(0, 200) : null;
  } catch {
    return null;
  }
}
