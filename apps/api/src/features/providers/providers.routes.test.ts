import type { ApiErrorBody, ElevenLabsModelsResponse, ElevenLabsVoicesResponse } from '@cortecho/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotConfiguredError } from '../../pipeline/services.ts';
import { createTestRuntime } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime> | null = null;

afterEach(() => {
  ctx?.sqlite.close();
  ctx = null;
});

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function providerFetch() {
  const state = { rejectKeys: false, previewCalls: [] as string[] };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (state.rejectKeys) return new Response('no', { status: 401 });
    if (url.includes('/v2/voices?page_size=1')) return Response.json({ voices: [] });
    if (url.endsWith('/v2/voices')) {
      return Response.json({
        voices: [
          {
            voice_id: 'voice-george',
            name: 'George',
            category: 'premade',
            labels: { accent: 'American', gender: 'male' },
            preview_url: 'https://cdn.example.test/george.mp3',
          },
        ],
      });
    }
    if (url.endsWith('/v1/models')) {
      return Response.json([
        { model_id: 'eleven_flash_v2_5', name: 'Flash 2.5', can_do_text_to_speech: true },
        { model_id: 'scribe_v3', name: 'Scribe 3', can_do_text_to_speech: false },
      ]);
    }
    if (url === 'https://cdn.example.test/george.mp3') {
      state.previewCalls.push(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-transcribe' }] });
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl, state };
}

async function setup() {
  const { fetchImpl, state } = providerFetch();
  ctx = createTestRuntime({ fetchImpl });
  const saveKey = await ctx.app.request(
    '/api/settings',
    patch({ version: 0, changes: { 'elevenlabs.apiKey': 'el-key' } }),
  );
  expect(saveKey.status).toBe(200);
  return { app: ctx.app, state };
}

describe('ElevenLabs provider routes', () => {
  it('calls the configured ELEVENLABS_BASE_URL (a proxy) for the lists', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/v2/voices')) return Response.json({ voices: [] });
      return Response.json([]);
    });
    ctx = createTestRuntime({
      fetchImpl,
      env: { ELEVENLABS_BASE_URL: 'http://gw.test:8080/elevenlabs/' },
    });
    await ctx.app.request('/api/settings', patch({ version: 0, changes: { 'elevenlabs.apiKey': 'el-key' } }));
    await ctx.app.request('/api/settings/elevenlabs-voices');
    expect(calls).toContain('http://gw.test:8080/elevenlabs/v2/voices');
  });

  it('degrades to empty lists and a 404 preview without a key', async () => {
    ctx = createTestRuntime({ fetchImpl: providerFetch().fetchImpl });
    const voices = await ctx.app.request('/api/settings/elevenlabs-voices');
    expect(voices.status).toBe(200);
    expect(await voices.json()).toEqual({ voices: [], reason: 'no-key' });
    const models = await ctx.app.request('/api/settings/elevenlabs-models');
    expect(await models.json()).toEqual({ models: [], reason: 'no-key' });
    const preview = await ctx.app.request('/api/settings/elevenlabs-voices/voice-george/preview');
    expect(preview.status).toBe(404);
  });

  it('explains a scoped key on both list endpoints', async () => {
    const scoped = () =>
      Response.json(
        {
          detail: {
            type: 'authentication_error',
            status: 'missing_permissions',
            message: 'The API key you used is missing the permission voices_read to execute this operation.',
          },
        },
        { status: 401 },
      );
    ctx = createTestRuntime({ fetchImpl: async () => scoped() });
    await ctx.app.request(
      '/api/settings',
      patch({ version: 0, changes: { 'elevenlabs.apiKey': 'scoped-key' } }),
    );
    expect(await (await ctx.app.request('/api/settings/elevenlabs-voices')).json()).toEqual({
      voices: [],
      reason: 'missing-permission',
    });
    expect(await (await ctx.app.request('/api/settings/elevenlabs-models')).json()).toEqual({
      models: [],
      reason: 'missing-permission',
    });
  });

  it('lists voices with labels and the preview URL, and models with their capability', async () => {
    const { app } = await setup();
    const voices = (await (
      await app.request('/api/settings/elevenlabs-voices')
    ).json()) as ElevenLabsVoicesResponse;
    expect(voices.voices).toEqual([
      {
        id: 'voice-george',
        name: 'George',
        category: 'premade',
        accent: 'American',
        gender: 'male',
        previewUrl: 'https://cdn.example.test/george.mp3',
      },
    ]);
    const models = (await (
      await app.request('/api/settings/elevenlabs-models')
    ).json()) as ElevenLabsModelsResponse;
    expect(models.models).toContainEqual({
      id: 'eleven_flash_v2_5',
      name: 'Flash 2.5',
      canDoTextToSpeech: true,
    });
    expect(models.models).toContainEqual({
      id: 'scribe_v3',
      name: 'Scribe 3',
      canDoTextToSpeech: false,
    });
  });

  it('streams a voice sample only for an id from the account list', async () => {
    const { app, state } = await setup();
    const preview = await app.request('/api/settings/elevenlabs-voices/voice-george/preview');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('audio/mpeg');
    expect(preview.headers.get('cache-control')).toContain('max-age');
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(state.previewCalls).toEqual(['https://cdn.example.test/george.mp3']);

    // A client-supplied id/URL is never fetched.
    const unknown = await app.request('/api/settings/elevenlabs-voices/https%3A%2F%2Fevil.test/preview');
    expect(unknown.status).toBe(404);
    expect(state.previewCalls).toHaveLength(1);
  });

  it('checks both provider keys and reports a rejected key', async () => {
    const { app, state } = await setup();
    const openai = await app.request('/api/settings/check-openai', post({ apiKey: 'sk-test' }));
    expect(await openai.json()).toEqual({ ok: true });
    const eleven = await app.request('/api/settings/check-elevenlabs', post({ apiKey: 'el-test' }));
    expect(await eleven.json()).toEqual({ ok: true });

    state.rejectKeys = true;
    const rejected = await app.request('/api/settings/check-elevenlabs', post({ apiKey: 'bad' }));
    expect(await rejected.json()).toEqual({ ok: false, code: 'rejected' });
  });

  it('synthesizes a WAV for the draft voice, and reports an unconfigured provider', async () => {
    ctx = createTestRuntime();
    const response = await ctx.app.request(
      '/api/settings/voice-sample',
      post({ provider: 'openai', voice: 'marin', text: 'Hello there.' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    const wav = Buffer.from(await response.arrayBuffer());
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.length).toBeGreaterThan(44);

    ctx.services.tts.synthesize = async function* () {
      yield Buffer.alloc(0);
      throw new NotConfiguredError('elevenlabs');
    };
    const failed = await ctx.app.request(
      '/api/settings/voice-sample',
      post({ provider: 'elevenlabs', elevenlabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb' }),
    );
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as ApiErrorBody).error.message).toContain('ElevenLabs is not configured');
  });

  it('asks for a key when none is typed or stored', async () => {
    ctx = createTestRuntime({ fetchImpl: providerFetch().fetchImpl });
    const response = await ctx.app.request('/api/settings/check-elevenlabs', post({}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.fields).toHaveProperty('apiKey');
  });
});
