import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotConfiguredError, PCM_SAMPLE_RATE } from '../services.ts';
import {
  checkElevenLabsKey,
  createElevenLabsProvider,
  listElevenLabsVoices,
  listElevenLabsVoicesDetailed,
} from './elevenlabs.ts';

function settings(changes: Record<string, unknown> = {}): Settings {
  return buildSettings({ ...DEFAULT_SETTINGS, ...changes });
}

const elevenLabsSettings = (changes: Record<string, unknown> = {}) =>
  settings({
    'elevenlabs.apiKey': 'el-secret-key',
    'stt.provider': 'elevenlabs',
    'tts.provider': 'elevenlabs',
    ...changes,
  });

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function audioResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'audio/pcm' } },
  );
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

afterEach(() => vi.unstubAllGlobals());

describe('ElevenLabs speech-to-text', () => {
  it('uploads a WAV with the model and language mapping', async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: '  What time is it?  ' }, { status: 200 }));
    const provider = createElevenLabsProvider();
    const text = await provider.transcribe(
      Buffer.alloc(640),
      16_000,
      new AbortController().signal,
      elevenLabsSettings({
        'stt.elevenlabsModel': 'scribe_v3',
        'stt.languages': ['en', 'ro', 'de'],
      }),
    );

    expect(text).toBe('What time is it?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'xi-api-key': 'el-secret-key' });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model_id')).toBe('scribe_v3');
    // The Echo's wake chime must not become "[beep]" in the request text.
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.get('language_code')).toBe('en');
    expect(form.getAll('secondary_language_codes')).toEqual(['ro', 'de']);
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('audio/wav');
  });

  it('sends only the first language to Scribe v2', async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: 'ok' }, { status: 200 }));
    await createElevenLabsProvider().transcribe(
      Buffer.alloc(320),
      16_000,
      new AbortController().signal,
      elevenLabsSettings({ 'stt.elevenlabsModel': 'scribe_v2', 'stt.languages': ['en', 'ro'] }),
    );
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('en');
    expect(form.getAll('secondary_language_codes')).toEqual([]);
  });

  it('fails fast without a key, without leaking one', async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: 'never' }));
    const provider = createElevenLabsProvider();
    const error = await provider
      .transcribe(
        Buffer.alloc(320),
        16_000,
        new AbortController().signal,
        settings({ 'stt.provider': 'elevenlabs' }),
      )
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as Error).message).toContain('ElevenLabs is not configured');
    expect((error as Error).message).not.toContain('sk-');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an HTTP failure without the key', async () => {
    stubFetch(async () => new Response('unauthorized', { status: 401 }));
    const error = await createElevenLabsProvider()
      .transcribe(Buffer.alloc(320), 16_000, new AbortController().signal, elevenLabsSettings())
      .catch((reason: unknown) => reason);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain('el-secret-key');
  });
});

describe('ElevenLabs key check', () => {
  const scoped = (permission: string) =>
    Response.json(
      {
        detail: {
          type: 'authentication_error',
          code: 'unauthorized',
          status: 'missing_permissions',
          message: `The API key you used is missing the permission ${permission} to execute this operation.`,
        },
      },
      { status: 401 },
    );

  it('accepts a fully scoped key', async () => {
    stubFetch(async () => Response.json({}, { status: 200 }));
    await expect(checkElevenLabsKey({ apiKey: 'key' })).resolves.toEqual({ ok: true });
  });

  it('accepts a key that authenticates but cannot list voices/models', async () => {
    stubFetch(async (url) => (url.includes('/v2/voices') ? scoped('voices_read') : scoped('models_read')));
    await expect(checkElevenLabsKey({ apiKey: 'key' })).resolves.toEqual({
      ok: true,
      missingPermissions: ['voices_read', 'models_read'],
    });
    vi.unstubAllGlobals();

    stubFetch(async (url) => (url.includes('/v2/voices') ? scoped('voices_read') : Response.json({})));
    await expect(checkElevenLabsKey({ apiKey: 'key' })).resolves.toEqual({
      ok: true,
      missingPermissions: ['voices_read'],
    });
  });

  it('rejects a key that fails authentication', async () => {
    stubFetch(async () =>
      Response.json({ detail: { status: 'invalid_api_key', message: 'bad key' } }, { status: 401 }),
    );
    await expect(checkElevenLabsKey({ apiKey: 'key' })).resolves.toEqual({
      ok: false,
      code: 'rejected',
    });
  });
});

describe('ElevenLabs voice list fallback', () => {
  const scoped = () =>
    Response.json(
      {
        detail: {
          type: 'authentication_error',
          code: 'unauthorized',
          status: 'missing_permissions',
          message: 'The API key you used is missing the permission voices_read to execute this operation.',
        },
      },
      { status: 401 },
    );

  const premade = {
    voice_id: 'premade-george',
    name: 'George - Warm, Captivating Storyteller',
    category: 'premade',
    labels: { accent: 'british', gender: 'male' },
    description: 'Warm resonance.',
    preview_url: 'https://cdn.example.test/george.mp3',
  };

  const mappedPremade = {
    id: 'premade-george',
    name: 'George - Warm, Captivating Storyteller',
    category: 'premade',
    accent: 'british',
    gender: 'male',
    description: 'Warm resonance.',
    previewUrl: 'https://cdn.example.test/george.mp3',
  };

  it('falls back to the anonymous /v1/voices list without sending the key', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v2/voices')) return scoped();
      if (url.endsWith('/v1/voices')) return Response.json({ voices: [premade] });
      return new Response('not found', { status: 404 });
    });
    const result = await listElevenLabsVoices({ apiKey: 'scoped-key' });

    expect(result).toEqual({
      voices: [mappedPremade],
      reason: 'missing-permission',
      source: 'premade',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.elevenlabs.io/v2/voices',
      'https://api.elevenlabs.io/v1/voices',
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ 'xi-api-key': 'scoped-key' });
    expect(calls[1]?.init?.headers).toEqual({ Accept: 'application/json' });
  });

  it('uses the built-in snapshot when the anonymous call also fails', async () => {
    stubFetch(async (url) => (url.endsWith('/v2/voices') ? scoped() : new Response('down', { status: 500 })));
    const result = await listElevenLabsVoicesDetailed({ apiKey: 'scoped-key' });

    expect(result.fromSnapshot).toBe(true);
    expect(result.response.source).toBe('premade');
    expect(result.response.reason).toBe('missing-permission');
    expect(result.response.voices).toHaveLength(21);
    expect(result.response.voices).toContainEqual(
      expect.objectContaining({
        id: 'JBFqnCBsd6RMkjVDRZzb',
        name: 'George - Warm, Captivating Storyteller',
      }),
    );
  });

  it('keeps a successful keyed list as the account source and makes no second request', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ voices: [{ voice_id: 'account-voice', name: 'My Voice' }] }),
    );
    const result = await listElevenLabsVoices({ apiKey: 'full-key' });

    expect(result).toEqual({
      voices: [{ id: 'account-voice', name: 'My Voice' }],
      source: 'account',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default voices when the account list is empty', async () => {
    const fetchMock = stubFetch(async (url) =>
      url.endsWith('/v2/voices') ? Response.json({ voices: [] }) : Response.json({ voices: [premade] }),
    );
    const result = await listElevenLabsVoices({ apiKey: 'empty-key' });

    expect(result).toEqual({ voices: [mappedPremade], source: 'premade' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a custom base URL for both requests', async () => {
    const urls: string[] = [];
    stubFetch(async (url) => {
      urls.push(url);
      return url.endsWith('/v2/voices') ? scoped() : Response.json({ voices: [premade] });
    });
    await listElevenLabsVoices({ apiKey: 'key', baseUrl: 'http://gw:8080/elevenlabs/' });

    expect(urls).toEqual(['http://gw:8080/elevenlabs/v2/voices', 'http://gw:8080/elevenlabs/v1/voices']);
  });
});

describe('ElevenLabs text-to-speech', () => {
  it('streams PCM from the voice stream endpoint with the clamped speed', async () => {
    const fetchMock = stubFetch(async () => audioResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));
    const controller = new AbortController();
    const provider = createElevenLabsProvider();
    const chunks = await collect(
      provider.synthesize(
        'Hello.',
        controller.signal,
        elevenLabsSettings({
          'tts.elevenlabsVoiceId': 'voice-42',
          'tts.elevenlabsModel': 'eleven_flash_v2_5',
          'tts.elevenlabsStability': 0.4,
          'tts.speed': 0.5,
        }),
      ),
    );

    expect(provider.sampleRate).toBe(24_000);
    expect(PCM_SAMPLE_RATE).toBe(24_000);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-42/stream?output_format=pcm_24000');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'xi-api-key': 'el-secret-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Hello.',
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.4, speed: 0.7 },
    });
    // The caller's abort signal reaches the request (merged with the timeout).
    expect(init.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('clamps a fast speed down to 1.2', async () => {
    const fetchMock = stubFetch(async () => audioResponse([new Uint8Array([1])]));
    await collect(
      createElevenLabsProvider().synthesize(
        'Fast.',
        new AbortController().signal,
        elevenLabsSettings({ 'tts.speed': 2 }),
      ),
    );
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).voice_settings.speed).toBe(1.2);
  });

  it('errors on an HTTP failure and never prints the key', async () => {
    stubFetch(async () => new Response('no', { status: 403 }));
    const error = await collect(
      createElevenLabsProvider().synthesize('Hi', new AbortController().signal, elevenLabsSettings()),
    ).catch((reason: unknown) => reason);
    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).not.toContain('el-secret-key');
  });

  it('uses ELEVENLABS_BASE_URL without a trailing slash for every request', async () => {
    const fetchMock = stubFetch(async (url) =>
      url.endsWith('/v1/speech-to-text')
        ? Response.json({ text: 'ok' })
        : audioResponse([new Uint8Array([1, 2])]),
    );
    const provider = createElevenLabsProvider({ baseUrl: 'http://gw:8080/elevenlabs/' });
    const signal = new AbortController().signal;
    await provider.transcribe(Buffer.alloc(2), 16_000, signal, elevenLabsSettings());
    await collect(provider.synthesize('Hi', signal, elevenLabsSettings()));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://gw:8080/elevenlabs/v1/speech-to-text',
      'http://gw:8080/elevenlabs/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_24000',
    ]);
  });
});
