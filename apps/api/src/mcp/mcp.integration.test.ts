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

async function createOpenConnector(description = 'A test server'): Promise<number> {
  const response = await ctx?.app.request('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Open tools',
      slug: 'open',
      url: fake?.url,
      authType: 'none',
      description,
      useServerInstructions: true,
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
    await ctx.mcp.resync(id, 'manual');
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

  it('manual refresh re-reads initialize, stores the new note and clears a dropped one', async () => {
    fake = await startFakeMcpServer({ requireAuth: false, instructions: 'model list v1' });
    ctx = makeRuntime();
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    type Status = { serverInstructions: string | null; serverInstructionsLength: number | null };
    const first = await json<Status>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(first.serverInstructions).toBe('model list v1');
    expect(first.serverInstructionsLength).toBe(13);

    fake.setInstructions('model list v2, now with models');
    const refreshed = await ctx.app.request(`/api/mcp/servers/${id}/tools/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    const second = await json<Status>(refreshed);
    expect(second.serverInstructions).toBe('model list v2, now with models');
    expect(second.serverInstructionsLength).toBe(30);

    fake.setInstructions(null);
    const cleared = await ctx.app.request(`/api/mcp/servers/${id}/tools/refresh`, { method: 'POST' });
    expect(cleared.status).toBe(200);
    const third = await json<Status>(cleared);
    expect(third.serverInstructions).toBeNull();
    expect(third.serverInstructionsLength).toBeNull();
  });

  it('reconnect after a dropped link re-reads initialize', async () => {
    fake = await startFakeMcpServer({
      requireAuth: false,
      stateful: true,
      instructions: 'before the restart',
    });
    ctx = makeRuntime();
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');
    const row = ctx.mcpRepository.get(id);
    expect(row).not.toBeNull();
    expect(ctx.mcpRepository.statusDetail(row as NonNullable<typeof row>).serverInstructions).toBe(
      'before the restart',
    );

    fake.setInstructions('after the restart, with the new model list');
    await fake.dropSessions();
    await ctx.mcp.reconnect(id);
    const detail = await json<{ serverInstructions: string | null }>(
      await ctx.app.request(`/api/mcp/servers/${id}`),
    );
    expect(detail.serverInstructions).toBe('after the restart, with the new model list');
  });

  it('list_changed updates tools without reconnecting and keeps pinning', async () => {
    fake = await startFakeMcpServer({ requireAuth: false, stateful: true });
    ctx = makeRuntime();
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');
    const connectedAt = ctx.mcp.connection(id)?.lastConnectedAt;

    await fake.addLateTool();
    await waitUntil(() => ctx?.mcpRepository.findTool(id, 'delete_everything') !== null);
    const detail = await json<{
      tools: { name: string; policy: string; review: string | null }[];
    }>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(detail.tools.find((tool) => tool.name === 'delete_everything')).toMatchObject({
      policy: 'off',
      review: 'new',
    });
    // A list_changed refresh must not close and reopen the link.
    expect(ctx.mcp.connection(id)?.lastConnectedAt).toBe(connectedAt);
  });

  it('waits for a running tool call before the manual refresh reopens the link', async () => {
    fake = await startFakeMcpServer({ requireAuth: false });
    ctx = makeRuntime();
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');
    const connection = ctx.mcp.connection(id);
    expect(connection).not.toBeNull();
    if (!connection) return;

    const call = connection.callTool('slow', { ms: 800 }, 5000);
    await ctx.mcp.resync(id, 'manual');
    await expect(call).resolves.toMatchObject({ content: [{ type: 'text', text: 'finally' }] });
    expect(connection.state).toBe('connected');
  });

  it('cuts a long note at the shared cap and keeps the full length', async () => {
    const note = `Models: ${'x'.repeat(1300)}`.slice(0, 1200);
    fake = await startFakeMcpServer({ requireAuth: false, instructions: note });
    ctx = makeRuntime();
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const detail = await json<{
      serverInstructions: string | null;
      serverInstructionsLength: number | null;
    }>(await ctx.app.request(`/api/mcp/servers/${id}`));
    expect(detail.serverInstructions?.length).toBe(500);
    expect(detail.serverInstructions).toBe(note.slice(0, 500));
    expect(detail.serverInstructionsLength).toBe(1200);
  });

  it('exposes exactly the instructions a turn sends, with the connector note', async () => {
    const note = 'Use the model list from this note.';
    fake = await startFakeMcpServer({ requireAuth: false, instructions: note });
    ctx = createTestRuntime({
      env: {
        CORTECHO_SECRET_KEY: SECRET,
        PUBLIC_BASE_URL: 'http://cortecho.test',
      },
      devices: [{ name: 'Kitchen', port: 26099, prompt: 'This Echo is in the kitchen.' }],
    });
    const id = await createOpenConnector();
    await waitUntil(() => ctx?.mcp.connection(id)?.state === 'connected');

    const deviceId = ctx.created[0]?.id ?? 0;
    expect(deviceId).toBeGreaterThan(0);
    const { settings } = ctx.settings.forDevice(deviceId);
    let sent = '';
    const agent = new ResponsesAgent({
      createResponse: async (request) => {
        sent = request.instructions;
        return {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'It is noon.' }],
            },
          ],
        };
      },
      tools: ctx.runtime.tools,
    });
    await agent.reply('what time is it', new AbortController().signal, undefined, {
      settings,
      session: ctx.sessions.get('preview-test', 60_000),
      toolSet: ctx.runtime.tools.snapshot({ settings, deviceId }),
      deviceId,
      device: { name: 'Kitchen', prompt: 'This Echo is in the kitchen.' },
    });

    const deviceDocument = await json<{ text: string }>(
      await ctx.app.request(`/api/devices/${deviceId}/instructions`),
    );
    expect(deviceDocument.text).toBe(sent);
    expect(deviceDocument.text).toContain('Connected services: Open tools');
    expect(deviceDocument.text).toContain(`Open tools: ${note}`);

    const globalDocument = await json<{ text: string; layers: { text: string }[] }>(
      await ctx.app.request('/api/settings/instructions'),
    );
    expect(globalDocument.text).toContain('Connected services: Open tools');
    expect(globalDocument.text).toContain(`Open tools: ${note}`);
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
