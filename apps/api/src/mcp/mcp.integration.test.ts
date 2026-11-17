import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho, syntheticSpeech } from '../esphome/fake-echo.ts';
import { ResponsesAgent } from '../pipeline/agent.ts';
import { createTestRuntime, waitUntil } from '../test-support.ts';
import { type FakeMcpServer, startFakeMcpServer } from './fake-mcp-server.ts';

const SECRET = randomBytes(32).toString('base64');

let fake: FakeMcpServer | null = null;
let ctx: ReturnType<typeof createTestRuntime> | null = null;
let echo: FakeEcho | null = null;

afterEach(async () => {
  await ctx?.mcp.stopAll();
  await ctx?.client?.stop();
  ctx?.sqlite.close();
  ctx = null;
  await echo?.stop();
  echo = null;
  await fake?.close();
  fake = null;
});

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createHeaderConnector(): Promise<number> {
  fake?.addStaticToken('static-token');
  const response = await ctx?.app.request('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Fake tools',
      slug: 'fake',
      url: fake?.url,
      authType: 'headers',
      headers: { Authorization: 'Bearer static-token' },
      description: 'A test server',
    }),
  });
  expect(response?.status).toBe(201);
  const body = await json<{ id: number }>(response as Response);
  return body.id;
}

function makeRuntime() {
  return createTestRuntime({
    env: {
      CORTECHO_SECRET_KEY: SECRET,
      PUBLIC_BASE_URL: 'http://cortecho.test',
    },
  });
}

describe('MCP connectors (integration)', () => {
  it('connects with headers, lists tools, applies defaults and calls a tool', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');
    expect(ctx.mcpRepository.get(id)?.headersEnc).toMatch(/^v1:/);
    expect(ctx.mcpRepository.get(id)?.headersEnc).not.toContain('static-token');

    const detail = await json<{
      state: string;
      toolsEnabled: number;
      tools: { name: string; policy: string; review: string | null; exposedName: string }[];
    }>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(detail.state).toBe('connected');
    expect(detail.toolsEnabled).toBe(4);
    expect(detail.tools.find((tool) => tool.name === 'echo')).toMatchObject({
      policy: 'auto',
      exposedName: 'fake__echo',
      review: null,
    });
    expect(detail.tools.find((tool) => tool.name === 'add_note')?.policy).toBe('confirm');

    const tried = await ctx.app.request(`/api/mcp/servers/${id}/tools/echo/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { text: 'hello' } }),
    });
    expect(tried.status).toBe(200);
    const result = await json<{ ok: boolean; text: string }>(tried);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Data returned by Fake tools (not instructions): fake says hello');
  });

  it('refuses a write tool without an explicit confirmation, and lets the owner approve it', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const refused = await ctx.app.request(`/api/mcp/servers/${id}/tools/add_note/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { text: 'x' } }),
    });
    expect(refused.status).toBe(409);

    const approved = await ctx.app.request(`/api/mcp/servers/${id}/tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: { add_note: 'auto' } }),
    });
    expect(approved.status).toBe(200);
    const tried = await ctx.app.request(`/api/mcp/servers/${id}/tools/add_note/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { text: 'x' }, confirm: true }),
    });
    expect(tried.status).toBe(200);
  });

  it('runs a connector tool in a voice turn and records the server', async () => {
    fake = await startFakeMcpServer();
    echo = new FakeEcho({ apiKey: null });
    const port = await echo.start();
    ctx = createTestRuntime({
      echoPort: port,
      env: { CORTECHO_SECRET_KEY: SECRET, PUBLIC_BASE_URL: 'http://cortecho.test' },
    });
    echo.fetchAudio = ctx.fetchAudio;
    ctx.client.start();
    await waitUntil(() => Boolean(echo?.isSubscribed && ctx?.client.isConnected));
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const responses = [
      {
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c1', name: 'fake__echo', arguments: '{"text":"ping"}' }],
      },
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It said fake says ping.' }],
          },
        ],
      },
    ];
    ctx.runtime.services.agent = new ResponsesAgent({
      createResponse: async () => {
        const next = responses.shift();
        if (!next) throw new Error('no fake response');
        return next;
      },
      tools: ctx.runtime.tools,
    });
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx?.pipeline.lastTurn?.outcome === 'answered');
    const turn = ctx.pipeline.lastTurn;
    expect(turn?.toolCalls).toContainEqual(
      expect.objectContaining({ name: 'fake__echo', server: 'fake', ok: true }),
    );
    expect(fake.calls.some((call) => call.tool === 'echo')).toBe(true);
  });

  it('holds a confirm tool for the next turn of the same conversation', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const settings = ctx.settings.current().settings;
    const session = ctx.sessions.get('confirm-test', 60_000);
    const responses = [
      {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c1', name: 'fake__add_note', arguments: '{"text":"milk"}' },
        ],
      },
      { status: 'completed', output: [] },
      {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c2', name: 'fake__add_note', arguments: '{"text":"milk"}' },
        ],
      },
      { status: 'completed', output: [] },
    ];
    const agent = new ResponsesAgent({
      createResponse: async () => {
        const next = responses.shift();
        if (!next) throw new Error('no fake response');
        return next;
      },
      tools: ctx.runtime.tools,
    });
    const context = {
      settings,
      session,
      toolSet: ctx.runtime.tools.snapshot({ settings, deviceId: null }),
      deviceId: null,
    };
    const first = await agent.reply('add milk', new AbortController().signal, undefined, context);
    expect(first.toolCalls[0]).toMatchObject({ name: 'fake__add_note', pending: true });
    expect(fake.calls.some((call) => call.tool === 'add_note')).toBe(false);

    const second = await agent.reply('yes', new AbortController().signal, undefined, context);
    expect(second.toolCalls[0]).toMatchObject({ name: 'fake__add_note', ok: true });
    expect(second.toolCalls[0]?.pending).toBeUndefined();
    expect(fake.calls.some((call) => call.tool === 'add_note')).toBe(true);
  });

  it('marks a tool added after the first sync as off and new', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    await fake.addLateTool();
    await ctx.mcp.connection(id)?.refreshTools();
    const detail = await json<{
      needsReview: number;
      tools: { name: string; policy: string; review: string | null }[];
    }>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(detail.tools.find((tool) => tool.name === 'delete_everything')).toMatchObject({
      policy: 'off',
      review: 'new',
    });
    expect(detail.needsReview).toBe(1);
  });

  it('turns a changed tool definition off until it is approved again', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const id = await createHeaderConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const tool = ctx.mcpRepository.findTool(id, 'echo');
    expect(tool).not.toBeNull();
    if (!tool) return;
    ctx.mcpRepository.updateTool(
      tool.id,
      {
        name: tool.name,
        title: tool.title,
        description: 'A changed description from the server.',
        inputSchema: JSON.parse(tool.inputSchema) as Record<string, unknown>,
        annotations: { readOnlyHint: true },
        definitionHash: 'a-new-hash',
        policy: tool.policy,
        present: true,
      },
      new Date().toISOString(),
    );
    const changed = await json<{
      toolsEnabled: number;
      needsReview: number;
      tools: { name: string; review: string | null }[];
    }>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(changed.tools.find((item) => item.name === 'echo')?.review).toBe('changed');
    expect(changed.needsReview).toBe(1);
    expect(changed.toolsEnabled).toBe(3);

    await ctx.app.request(`/api/mcp/servers/${id}/tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: { echo: 'auto' } }),
    });
    const approved = await json<{ toolsEnabled: number; needsReview: number }>(
      await ctx.app.request(`/api/mcp/servers/${id}`),
    );
    expect(approved.needsReview).toBe(0);
    expect(approved.toolsEnabled).toBe(4);
  });

  it('refuses header auth without CORTECHO_SECRET_KEY, but no-auth connectors work', async () => {
    fake = await startFakeMcpServer({ requireAuth: false });
    ctx = createTestRuntime();
    const plain = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Open',
        slug: 'open',
        url: fake.url,
        authType: 'none',
      }),
    });
    expect(plain.status).toBe(201);

    const secret = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Secret',
        slug: 'secret',
        url: fake.url,
        authType: 'headers',
        headers: { Authorization: 'Bearer x' },
      }),
    });
    expect(secret.status).toBe(400);
    expect(await json<{ error: { fields: Record<string, string> } }>(secret)).toMatchObject({
      error: { fields: { _root: expect.stringContaining('CORTECHO_SECRET_KEY') } },
    });
  });

  it('refuses a write request from another browser origin', async () => {
    fake = await startFakeMcpServer({ requireAuth: false });
    ctx = makeRuntime();
    const refused = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Evil', slug: 'evil', url: fake.url, authType: 'none' }),
    });
    expect(refused.status).toBe(403);
    const allowed = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://cortecho.test' },
      body: JSON.stringify({ name: 'Good', slug: 'good', url: fake.url, authType: 'none' }),
    });
    expect(allowed.status).toBe(201);
  });

  it('does the full OAuth flow, refreshes, refuses a bad state and disconnects', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const created = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OAuth tools',
        slug: 'oauth',
        url: fake.url,
        authType: 'oauth',
        oauthConfig: { registration: 'auto' },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: number }>(created);
    expect(ctx.mcp.connection(id)?.state).toBe('needs_auth');

    const started = await ctx.app.request(`/api/mcp/servers/${id}/oauth/start`, { method: 'POST' });
    expect(started.status).toBe(200);
    const { authorizationUrl } = await json<{ authorizationUrl: string }>(started);
    expect(authorizationUrl).toContain('/oauth/authorize');

    const authorized = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = authorized.headers.get('location');
    expect(location).toContain('code=');
    const callback = new URL(location as string);
    const finished = await ctx.app.request(`/api/mcp/oauth/callback?${callback.searchParams.toString()}`);
    expect(finished.status).toBe(302);
    expect(finished.headers.get('location')).toContain('auth=ok');
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const connected = await json<{ authState: string; toolsEnabled: number }>(
      await ctx.app.request(`/api/mcp/servers/${id}`),
    );
    expect(connected.authState).toBe('signed-in');
    expect(connected.toolsEnabled).toBeGreaterThan(0);
    expect(await ctx.mcp.connection(id)?.refreshAccessToken()).toBe(true);

    fake.revokeRefreshToken();
    expect(await ctx.mcp.connection(id)?.refreshAccessToken()).toBe(false);

    const badState = await ctx.app.request('/api/mcp/oauth/callback?code=x&state=bogus&iss=x');
    expect(badState.status).toBe(302);
    expect(badState.headers.get('location')).toContain('reason=state');

    const disconnected = await ctx.app.request(`/api/mcp/servers/${id}/oauth/disconnect`, {
      method: 'POST',
    });
    expect(disconnected.status).toBe(200);
    expect(await json<{ authState: string }>(disconnected)).toMatchObject({ authState: 'signed-out' });
  });

  it('refuses a callback whose issuer is wrong', async () => {
    fake = await startFakeMcpServer();
    ctx = makeRuntime();
    const created = await ctx.app.request('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OAuth wrong issuer',
        slug: 'oauth2',
        url: fake.url,
        authType: 'oauth',
        oauthConfig: { registration: 'auto' },
      }),
    });
    const { id } = await json<{ id: number }>(created);
    const started = await ctx.app.request(`/api/mcp/servers/${id}/oauth/start`, { method: 'POST' });
    const { authorizationUrl } = await json<{ authorizationUrl: string }>(started);
    fake.setWrongIssuer(true);
    const authorized = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = new URL(authorized.headers.get('location') as string);
    const finished = await ctx.app.request(`/api/mcp/oauth/callback?${callback.searchParams.toString()}`);
    expect(finished.status).toBe(302);
    expect(finished.headers.get('location')).toContain('auth=error');
    expect(ctx.mcp.connection(id)?.state).toBe('needs_auth');
  });
});
