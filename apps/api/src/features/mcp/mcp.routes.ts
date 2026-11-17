import {
  CONNECTOR_CATALOG,
  type McpServerDetail,
  mcpOauthCompleteSchema,
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  mcpToolPolicyPatchSchema,
  mcpToolTrySchema,
} from '@cortecho/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { AppError, validationError } from '../../lib/errors.ts';
import { createLogger, errorMessage } from '../../lib/logger.ts';
import { validate } from '../../lib/validation.ts';
import {
  DuplicateConnectorError,
  type McpServerWrite,
  SecretKeyMissingError,
} from '../../mcp/mcp.repository.ts';
import { ConnectorAuthError, ConnectorUnavailableError } from '../../mcp/mcp-connection.ts';
import { effectivePolicy } from '../../mcp/mcp-manager.ts';
import { authFailureText, resultToText, truncateResult, wrapResult } from '../../mcp/tool-mapping.ts';
import { checkServerUrlResolved } from '../../mcp/url-policy.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { parseJson, toServerDetail, toServerStatus } from './mcp.presenter.ts';

const log = createLogger('mcp-routes');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The connectors API. Secrets are write-only: responses carry `hasHeaders` /
 * `hasClientSecret` only. Write routes accept requests from this origin (or
 * MCP_ALLOWED_ORIGINS); a request without an Origin (curl, scripts, tests) is
 * allowed, because this is a CSRF guard, not authentication.
 */
export function createMcpRoutes(runtime: VoiceRuntime) {
  const manager = runtime.mcp;

  function serverOr404(id: number) {
    const row = manager.repository.get(id);
    if (!row) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
    return row;
  }

  function guardOrigin(c: Context): void {
    if (SAFE_METHODS.has(c.req.method)) return;
    const origin = c.req.header('origin');
    if (!origin) return; // non-browser client
    if (origin === 'null') throw new AppError(403, 'VALIDATION_ERROR', 'This origin is not allowed.');
    const allowed = new Set(runtime.config.mcp.allowedOrigins);
    if (runtime.config.mcp.publicBaseUrl) {
      try {
        allowed.add(new URL(runtime.config.mcp.publicBaseUrl).origin);
      } catch {
        // Config validation reports the bad URL elsewhere.
      }
    }
    try {
      allowed.add(new URL(c.req.url).origin);
    } catch {
      // A malformed request URL cannot match anyway.
    }
    if (!allowed.has(origin)) {
      throw new AppError(403, 'VALIDATION_ERROR', 'This origin is not allowed to change connectors.');
    }
  }

  function toAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof SecretKeyMissingError) {
      return validationError({ _root: error.message });
    }
    if (error instanceof DuplicateConnectorError) {
      return new AppError(409, 'CONFLICT', error.message, { [error.field]: error.message });
    }
    if (error instanceof ConnectorUnavailableError) {
      return new AppError(502, 'UPSTREAM_ERROR', error.message);
    }
    if (error instanceof ConnectorAuthError) {
      return new AppError(409, 'CONFLICT', error.message);
    }
    return new AppError(502, 'UPSTREAM_ERROR', errorMessage(error));
  }

  async function assertUrl(raw: string): Promise<void> {
    const checked = await checkServerUrlResolved(raw);
    if (!checked.ok) throw validationError({ url: checked.message });
  }

  function detail(id: number): McpServerDetail {
    return toServerDetail(manager, serverOr404(id));
  }

  return new Hono()
    .use('/mcp/*', async (c, next) => {
      guardOrigin(c);
      await next();
    })

    .get('/mcp/catalog', (c) =>
      c.json({
        entries: CONNECTOR_CATALOG,
        secretKeyConfigured: manager.repository.secretKeyConfigured(),
      }),
    )

    .get('/mcp/servers', (c) => c.json(manager.rows().map((row) => toServerStatus(manager, row))))

    .post('/mcp/servers', validate('json', mcpServerCreateSchema), async (c) => {
      const body = c.req.valid('json');
      await assertUrl(body.url);
      const oauthConfig = body.oauthConfig ?? { registration: 'auto' as const };
      const write: McpServerWrite = {
        slug: body.slug,
        name: body.name,
        catalogId: body.catalogId ?? null,
        transport: body.transport as McpServerWrite['transport'],
        url: body.url,
        enabled: body.enabled,
        description: body.description,
        authType: body.authType,
        headers: body.headers,
        oauthConfig,
        clientSecret: body.clientSecret,
        timeoutMs: body.timeoutMs,
        maxResultChars: body.maxResultChars,
        useServerInstructions: body.useServerInstructions,
      };
      try {
        const row = manager.repository.create(write);
        await manager.add(row);
        return c.json(toServerDetail(manager, row), 201);
      } catch (error) {
        throw toAppError(error);
      }
    })

    .get('/mcp/servers/:id', (c) => c.json(detail(connectorId(c.req.param('id')))))

    .patch('/mcp/servers/:id', validate('json', mcpServerUpdateSchema), async (c) => {
      const id = connectorId(c.req.param('id'));
      const before = serverOr404(id);
      const body = c.req.valid('json');
      const url = body.url ?? before.url;
      if (body.url !== undefined && body.url !== before.url) await assertUrl(url);
      const currentOauth = manager.repository.oauthConfig(before);
      const oauthConfig =
        body.oauthConfig === undefined
          ? currentOauth
          : (body.oauthConfig ?? { registration: 'auto' as const });
      const authType = body.authType ?? before.authType;
      const clientIdChanged = oauthConfig.clientId !== currentOauth.clientId;
      const credentialsReset =
        (body.url !== undefined && body.url !== before.url) ||
        clientIdChanged ||
        body.clientSecret !== undefined ||
        authType !== before.authType ||
        oauthConfig.registration !== currentOauth.registration;
      const write: McpServerWrite = {
        slug: before.slug,
        name: body.name ?? before.name,
        catalogId: body.catalogId === undefined ? before.catalogId : body.catalogId,
        transport: (body.transport ?? before.transport) as McpServerWrite['transport'],
        url,
        enabled: body.enabled ?? before.enabled,
        description: body.description ?? before.description,
        authType,
        headers: body.headers === undefined ? undefined : body.headers,
        oauthConfig,
        clientSecret: body.clientSecret === undefined ? undefined : body.clientSecret,
        timeoutMs: body.timeoutMs ?? before.timeoutMs,
        maxResultChars: body.maxResultChars ?? before.maxResultChars,
        useServerInstructions: body.useServerInstructions ?? before.useServerInstructions,
      };
      const resultHeaders =
        body.headers === undefined ? manager.repository.headers(before) : (body.headers ?? {});
      if (authType === 'headers' && Object.keys(resultHeaders).length === 0) {
        throw validationError({ headers: 'Add at least one header.' });
      }
      if (authType === 'oauth' && oauthConfig.registration === 'preregistered') {
        const secret =
          body.clientSecret === undefined ? manager.repository.clientSecret(before) : body.clientSecret;
        if (!oauthConfig.clientId) throw validationError({ 'oauthConfig.clientId': 'Enter the client ID.' });
        if (!secret) throw validationError({ clientSecret: 'Enter the client secret.' });
      }
      try {
        const after = manager.repository.update(id, write);
        if (!after) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
        if (credentialsReset) manager.repository.removeCredentials(id);
        await manager.update(before, after);
        return c.json(toServerDetail(manager, after));
      } catch (error) {
        throw toAppError(error);
      }
    })

    .delete('/mcp/servers/:id', async (c) => {
      const id = connectorId(c.req.param('id'));
      serverOr404(id);
      await manager.remove(id);
      manager.repository.remove(id);
      return c.body(null, 204);
    })

    .post('/mcp/servers/:id/reconnect', async (c) => {
      const id = connectorId(c.req.param('id'));
      serverOr404(id);
      await manager.reconnect(id);
      return c.json(detail(id));
    })

    .post('/mcp/servers/:id/oauth/start', async (c) => {
      const id = connectorId(c.req.param('id'));
      const row = serverOr404(id);
      if (row.authType !== 'oauth') throw validationError({ _root: 'This connector does not use OAuth.' });
      manager.setPublicBaseUrl(new URL(c.req.url).origin);
      const connection = manager.connection(id);
      if (!connection) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
      try {
        const authorizationUrl = await connection.startOAuth();
        return c.json({ authorizationUrl });
      } catch (error) {
        throw toAppError(error);
      }
    })

    .get('/mcp/oauth/callback', async (c) => {
      const params = new URL(c.req.url).searchParams;
      const state = params.get('state');
      const serverId = state ? manager.flowServer(state) : null;
      if (!state || serverId === null) {
        return c.redirect('/settings?tab=connectors&auth=error&reason=state', 302);
      }
      const connection = manager.connection(serverId);
      if (!connection) return c.redirect('/settings?tab=connectors&auth=error&reason=server', 302);
      try {
        await connection.finishOAuth(params);
        manager.finishFlow(state);
        return c.redirect(`/settings?tab=connectors&server=${serverId}&auth=ok`, 302);
      } catch (error) {
        // The callback's error text is attacker-controlled: never echo it.
        log.warn(`OAuth callback failed for connector #${serverId}: ${errorMessage(error)}`);
        return c.redirect(`/settings?tab=connectors&server=${serverId}&auth=error&reason=exchange`, 302);
      }
    })

    .post('/mcp/oauth/complete', validate('json', mcpOauthCompleteSchema), async (c) => {
      const { callbackUrl } = c.req.valid('json');
      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        throw validationError({ callbackUrl: 'Paste the full URL from the browser address bar.' });
      }
      const state = url.searchParams.get('state');
      const serverId = state ? manager.flowServer(state) : null;
      if (!state || serverId === null) {
        throw validationError({ callbackUrl: 'That URL does not belong to a sign-in in progress.' });
      }
      const connection = manager.connection(serverId);
      if (!connection) throw new AppError(404, 'NOT_FOUND', `No connector #${serverId}.`);
      try {
        await connection.finishOAuth(url.searchParams);
        manager.finishFlow(state);
        return c.json(detail(serverId));
      } catch (error) {
        throw toAppError(error);
      }
    })

    .post('/mcp/servers/:id/oauth/disconnect', async (c) => {
      const id = connectorId(c.req.param('id'));
      serverOr404(id);
      const connection = manager.connection(id);
      if (!connection) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
      await connection.disconnectOAuth();
      return c.json(detail(id));
    })

    .post('/mcp/servers/:id/tools/refresh', async (c) => {
      const id = connectorId(c.req.param('id'));
      serverOr404(id);
      const connection = manager.connection(id);
      if (!connection) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
      try {
        await connection.refreshTools();
        return c.json(detail(id));
      } catch (error) {
        throw toAppError(error);
      }
    })

    .patch('/mcp/servers/:id/tools', validate('json', mcpToolPolicyPatchSchema), (c) => {
      const id = connectorId(c.req.param('id'));
      serverOr404(id);
      const { policies } = c.req.valid('json');
      for (const [name, policy] of Object.entries(policies)) {
        const tool = manager.repository.findTool(id, name);
        if (!tool) continue;
        // Approving a policy also approves the definition the owner saw.
        manager.repository.setToolPolicy(tool.id, policy, tool.definitionHash);
      }
      return c.json(detail(id));
    })

    .post('/mcp/servers/:id/tools/:name/try', validate('json', mcpToolTrySchema), async (c) => {
      const id = connectorId(c.req.param('id'));
      const row = serverOr404(id);
      const name = c.req.param('name');
      const tool = manager.repository.findTool(id, name);
      if (!tool) throw new AppError(404, 'NOT_FOUND', `No tool "${name}" on this connector.`);
      if (!tool.present) throw validationError({ _root: 'The server no longer lists this tool.' });
      if (effectivePolicy(tool) === 'off') {
        throw validationError({ _root: 'Approve this tool (or turn it on) before trying it.' });
      }
      const annotations = parseJson<Record<string, unknown>>(tool.annotations, {});
      const write = annotations.readOnlyHint !== true || annotations.destructiveHint === true;
      const { arguments: args, confirm } = c.req.valid('json');
      if (write && !confirm) {
        return c.json(
          {
            error: {
              code: 'CONFLICT' as const,
              message: 'This tool changes something. Confirm it explicitly to try it.',
              fields: { confirm: 'Tick “I understand this changes something”.' },
            },
          },
          409,
        );
      }
      const connection = manager.connection(id);
      if (!connection) throw new AppError(404, 'NOT_FOUND', `No connector #${id}.`);
      const started = Date.now();
      try {
        const result = (await connection.callTool(tool.name, args, row.timeoutMs)) as Record<string, unknown>;
        const text = resultToText(result);
        const wrapped = wrapResult(row.name, truncateResult(text, row.maxResultChars));
        return c.json({
          ok: result.isError !== true,
          text: wrapped,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        if (error instanceof ConnectorAuthError) {
          return c.json({
            ok: false,
            text: authFailureText(row.name),
            durationMs: Date.now() - started,
          });
        }
        if (error instanceof ConnectorUnavailableError) {
          return c.json({
            ok: false,
            text: `error: ${error.message}`,
            durationMs: Date.now() - started,
          });
        }
        throw toAppError(error);
      }
    })

    .get('/mcp/oauth/client-metadata.json', (c) => {
      if (!runtime.config.mcp.cimdEnabled) {
        throw new AppError(404, 'NOT_FOUND', 'Client ID Metadata Documents are disabled.');
      }
      manager.setPublicBaseUrl(new URL(c.req.url).origin);
      const base = manager.baseUrl();
      return c.json(
        {
          client_name: 'Cortecho',
          client_uri: base,
          redirect_uris: [`${base}/api/mcp/oauth/callback`],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          application_type: 'web',
        },
        200,
        { 'Cache-Control': 'public, max-age=300' },
      );
    });
}

function connectorId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'NOT_FOUND', 'No such connector.');
  return id;
}
