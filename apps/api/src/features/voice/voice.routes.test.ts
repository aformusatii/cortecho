import type { ApiErrorBody, AskResponse, Health, SayResponse, Turn } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { createTestRuntime } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime>;

function setup() {
  ctx = createTestRuntime();
  return createApp({ db: ctx.db, voice: ctx.runtime });
}

afterEach(() => ctx.sqlite.close());

/** Typed JSON body (the tests assert its shape anyway). */
const json = <T>(response: Response) => response.json() as Promise<T>;

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('voice routes', () => {
  it('GET /api/health and /health report every Echo and the OpenAI state', async () => {
    const app = setup();
    for (const path of ['/api/health', '/health']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = await json<Health>(response);
      expect(body).toMatchObject({
        status: 'ok',
        devices: [],
        openai: { configured: true },
        lastTurn: null,
      });
      expect(body.tools).toContain('echo_test');
      expect(body.settingsVersion).toBe(0);
    }
  });

  it('POST /api/ask runs the agent and records the turn', async () => {
    const app = setup();
    const response = await app.request('/api/ask', post({ text: '  what time is it ' }));
    expect(response.status).toBe(200);
    const { turn } = await json<AskResponse>(response);
    expect(turn).toMatchObject({
      source: 'ask',
      outcome: 'answered',
      transcript: 'what time is it',
      reply: 'It is noon.',
    });

    const list = await json<Turn[]>(await app.request('/api/turns?limit=5'));
    expect(list).toHaveLength(1);
    expect((await json<Health>(await app.request('/api/health'))).lastTurn?.id).toBe(turn.id);
  });

  it('persists search display metadata through ask and history', async () => {
    const app = setup();
    const display = {
      displayText: 'Fact. [1]',
      citations: [{ start: 6, end: 9, url: 'https://example.com', title: 'Source' }],
    };
    ctx.services.agentResult = async () => ({ text: 'Fact.', toolCalls: [], ...display });
    const response = await app.request('/api/ask', post({ text: 'Search for a fact' }));
    expect(response.status).toBe(200);
    expect((await json<AskResponse>(response)).turn).toMatchObject({ reply: 'Fact.', ...display });
    expect((await json<Turn[]>(await app.request('/api/turns')))[0]).toMatchObject(display);
  });

  it('POST /api/ask reports agent failures as UPSTREAM_ERROR', async () => {
    const app = setup();
    ctx.services.agentResult = async () => {
      throw new Error('quota exceeded');
    };
    const response = await app.request('/api/ask', post({ text: 'hi' }));
    expect(response.status).toBe(502);
    expect((await json<ApiErrorBody>(response)).error).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('POST /api/say with no device reports per-device results (empty when none exist)', async () => {
    const app = setup();
    const response = await app.request('/api/say', post({ text: 'hello' }));
    expect(response.status).toBe(200);
    expect(await json<SayResponse>(response)).toEqual({ results: [] });
  });

  it('POST /api/say refuses both a device and all', async () => {
    const app = setup();
    const response = await app.request('/api/say', post({ text: 'hello', deviceId: 1, all: true }));
    expect(response.status).toBe(400);
    expect((await json<ApiErrorBody>(response)).error.code).toBe('VALIDATION_ERROR');
  });

  it('validates the request body', async () => {
    const app = setup();
    const response = await app.request('/api/ask', post({ text: '   ' }));
    expect(response.status).toBe(400);
    expect((await json<ApiErrorBody>(response)).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: { text: 'Enter some text.' },
    });
  });

  it('GET /api/reply-audio serves the current reply only, by its id', async () => {
    const app = setup();
    expect((await app.request('/api/reply-audio/nothing.wav')).status).toBe(404);
    async function* tts() {
      yield Buffer.alloc(4800, 1);
    }
    const reply = ctx.replies.create(tts(), 24000);
    await reply.finished();
    const response = await app.request(`/api/reply-audio/${reply.id}.wav`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    const wav = Buffer.from(await response.arrayBuffer());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + 4800);

    const other = 'A'.repeat(22);
    expect((await app.request(`/api/reply-audio/${other}.wav`)).status).toBe(404);
    // One reply per Echo: a new one does not evict another device's, but the
    // pipeline revokes its own previous reply when it starts a new one.
    ctx.replies.create(tts(), 24000);
    expect((await app.request(`/api/reply-audio/${reply.id}.wav`)).status).toBe(200);
    ctx.replies.revoke(reply);
    expect((await app.request(`/api/reply-audio/${reply.id}.wav`)).status).toBe(404);
  });

  it('POST /api/conversation/reset drops the web session', async () => {
    const app = setup();
    await app.request('/api/ask', post({ text: 'hello' }));
    expect(ctx.sessions.has('web')).toBe(true);
    const reset = await app.request('/api/conversation/reset', { method: 'POST' });
    expect(reset.status).toBe(204);
    expect(ctx.sessions.has('web')).toBe(false);
  });

  it('GET /api/turns validates the limit', async () => {
    const app = setup();
    expect((await app.request('/api/turns?limit=1000')).status).toBe(400);
  });
});
