import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/**
 * The only container with internet access: the AI gateway for the integration
 * suite. OpenAI stays on /v1/*; ElevenLabs is mounted on /elevenlabs/* (the
 * prefix is stripped) so the two /v1/models endpoints never collide.
 *
 * In real mode each provider's key is injected here; in mock mode the answers
 * are deterministic. Bodies, audio, transcripts and keys are never logged or
 * stored: /calls only knows service, method, path, status, time and model.
 */

const OPENAI_MODE = process.env.OPENAI_MODE ?? 'mock';
const ELEVENLABS_MODE = process.env.ELEVENLABS_MODE ?? 'mock';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const PORT = 8080;
const OPENAI_UPSTREAM = 'https://api.openai.com';
const ELEVENLABS_UPSTREAM = 'https://api.elevenlabs.io';
/** A sentinel the Providers-tab check uses for a scoped key (never a real key). */
const MISSING_PERMISSIONS_KEY = 'missing-permissions-key';

for (const [name, value] of [
  ['OPENAI_MODE', OPENAI_MODE],
  ['ELEVENLABS_MODE', ELEVENLABS_MODE],
] as const) {
  if (value !== 'mock' && value !== 'real' && !(name === 'ELEVENLABS_MODE' && value === 'skip')) {
    console.error(`ai-gw: ${name} must be "mock", "real"${name === 'ELEVENLABS_MODE' ? ' or "skip"' : ''}`);
    process.exit(1);
  }
}
if (OPENAI_MODE === 'real' && OPENAI_KEY.trim() === '') {
  console.error('ai-gw: OPENAI_MODE=real needs OPENAI_API_KEY');
  process.exit(1);
}
if (ELEVENLABS_MODE === 'real' && ELEVENLABS_KEY.trim() === '') {
  console.error('ai-gw: ELEVENLABS_MODE=real needs ELEVENLABS_API_KEY');
  process.exit(1);
}

type Service = 'openai' | 'elevenlabs';
type Call = {
  at: string;
  service: Service;
  method: string;
  path: string;
  status: number;
  ms: number;
  model?: string;
};
/** Since the last POST /calls/reset, for one scenario's assertions. */
const calls: Call[] = [];
/** Every provider call in the whole run, for summary.md (never reset). */
const history: Call[] = [];

createServer((req, res) => {
  const startedAt = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://gateway');
  const service: Service = url.pathname.startsWith('/elevenlabs/') ? 'elevenlabs' : 'openai';
  const call: Call = {
    at: new Date().toISOString(),
    service,
    method,
    path: url.pathname,
    status: 0,
    ms: 0,
  };
  // Only provider traffic belongs in /calls; health checks and /calls itself
  // would otherwise be noise in the report.
  if (
    url.pathname.startsWith('/v1/') ||
    url.pathname.startsWith('/elevenlabs/v1/') ||
    url.pathname.startsWith('/elevenlabs/v2/')
  ) {
    calls.push(call);
    history.push(call);
  }
  res.on('finish', () => {
    call.status = res.statusCode;
    call.ms = Date.now() - startedAt;
  });
  void handle(req, res, method, url.pathname, url.search, call).catch((error) => {
    sendJson(res, 502, { error: { message: String(error) } });
  });
}).listen(PORT, '0.0.0.0');

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  search: string,
  call: Call,
): Promise<void> {
  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, mode: OPENAI_MODE, elevenlabs: ELEVENLABS_MODE });
    return;
  }
  if (method === 'GET' && path === '/calls') {
    sendJson(res, 200, calls);
    return;
  }
  if (method === 'GET' && path === '/calls/all') {
    sendJson(res, 200, history);
    return;
  }
  if (method === 'POST' && path === '/calls/reset') {
    calls.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path.startsWith('/elevenlabs/')) {
    await handleElevenLabs(req, res, method, path.slice('/elevenlabs'.length), search, call);
    return;
  }
  if (!path.startsWith('/v1/')) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }
  if (OPENAI_MODE === 'real') {
    await proxy(req, res, method, OPENAI_UPSTREAM, path + search, 'authorization', `Bearer ${OPENAI_KEY}`);
    return;
  }
  await mockOpenAi(req, res, method, path, call);
}

async function handleElevenLabs(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  search: string,
  call: Call,
): Promise<void> {
  if (ELEVENLABS_MODE === 'skip') {
    sendJson(res, 503, { detail: { message: 'ElevenLabs is disabled in this run' } });
    return;
  }
  if (ELEVENLABS_MODE === 'real') {
    await proxy(req, res, method, ELEVENLABS_UPSTREAM, path + search, 'xi-api-key', ELEVENLABS_KEY);
    return;
  }
  await mockElevenLabs(req, res, method, path, call);
}

/** The same proxy for both providers: stream the body, replace only the key. */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  upstreamBase: string,
  path: string,
  keyHeader: 'authorization' | 'xi-api-key',
  keyValue: string,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (['host', 'authorization', 'xi-api-key', 'connection', 'transfer-encoding'].includes(lower)) {
      continue;
    }
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  headers.set(keyHeader, keyValue);

  const init = { method, headers } as RequestInit & { duplex?: 'half' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as NonNullable<RequestInit['body']>;
    init.duplex = 'half';
  }

  const upstream = await fetch(`${upstreamBase}${path}`, init);
  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) return;
    outHeaders[name] = value;
  });
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as NodeReadableStream).pipe(res);
}

async function mockOpenAi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  call: Call,
): Promise<void> {
  if (path === '/v1/models' && (method === 'GET' || method === 'HEAD')) {
    call.model = 'gpt-mock';
    if (method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
      return;
    }
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'gpt-mock', object: 'model', created: 0, owned_by: 'onboarding-gw' }],
    });
    return;
  }

  if (path === '/v1/audio/transcriptions' && method === 'POST') {
    const body = await readBody(req);
    call.model = extractModel(body, req.headers['content-type'] ?? '');
    sendJson(res, 200, { text: 'What time is it?' });
    return;
  }

  if (path === '/v1/responses' && method === 'POST') {
    const body = await readBody(req);
    call.model = extractModel(body, req.headers['content-type'] ?? '');
    sendResponses(res, call.model ?? 'gpt-mock');
    return;
  }

  if (path === '/v1/audio/speech' && method === 'POST') {
    const body = await readBody(req);
    call.model = extractModel(body, req.headers['content-type'] ?? '');
    const pcm = tone(24_000, 1);
    res.writeHead(200, { 'content-type': 'audio/pcm', 'content-length': pcm.length });
    res.end(pcm);
    return;
  }

  sendJson(res, 404, { error: { message: `mock: no route for ${method} ${path}` } });
}

async function mockElevenLabs(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  call: Call,
): Promise<void> {
  const key = req.headers['xi-api-key'];
  if (key === MISSING_PERMISSIONS_KEY && (path === '/v2/voices' || path === '/v1/models')) {
    sendJson(res, 401, {
      detail: {
        status: 'missing_permissions',
        message: 'missing permission voices_read',
      },
    });
    return;
  }

  if (path === '/v2/voices' && method === 'GET') {
    sendJson(res, 200, {
      voices: [
        {
          voice_id: 'mock-voice',
          name: 'Mock Voice',
          category: 'premade',
          description: 'The deterministic integration-suite voice.',
        },
      ],
    });
    return;
  }

  if (path === '/v1/models' && method === 'GET') {
    sendJson(res, 200, [
      { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true },
      { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true },
      { model_id: 'scribe_v3', name: 'Scribe v3', can_do_text_to_speech: false },
    ]);
    return;
  }

  if (path === '/v1/speech-to-text' && method === 'POST') {
    const body = await readBody(req);
    call.model = /name="model_id"\r?\n\r?\n([^\r\n]+)/.exec(body)?.[1];
    sendJson(res, 200, { text: 'What time is it?' });
    return;
  }

  const tts = /^\/v1\/text-to-speech\/[^/]+\/stream$/.exec(path);
  if (tts && method === 'POST') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body) as { model_id?: unknown };
      call.model = typeof parsed.model_id === 'string' ? parsed.model_id : undefined;
    } catch {
      call.model = undefined;
    }
    // A different pitch from OpenAI's mock tone proves which provider spoke.
    const pcm = tone(24_000, 1, 880);
    res.writeHead(200, { 'content-type': 'audio/pcm', 'content-length': pcm.length });
    res.end(pcm);
    return;
  }

  sendJson(res, 404, { detail: { message: `mock: no route for ${method} /elevenlabs${path}` } });
}

/** The events `openai.ts` and the Responses agent consume from the SDK stream. */
function sendResponses(res: ServerResponse, model: string): void {
  const text = "It's 14:05.";
  const message = {
    id: 'msg_onboarding_mock',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp_onboarding_mock',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [message],
    output_text: text,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sse(res, 'response.created', {
    type: 'response.created',
    response: { ...response, status: 'in_progress', output: [], output_text: '' },
  });
  sse(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...message, status: 'in_progress', content: [] },
  });
  const first = "It's ";
  const second = '14:05.';
  for (const delta of [first, second]) {
    sse(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }
  sse(res, 'response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: message,
  });
  sse(res, 'response.completed', { type: 'response.completed', response });
  res.end();
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A quiet tone as 16-bit signed LE PCM (440 Hz for OpenAI, 880 Hz for ElevenLabs). */
function tone(sampleRate: number, seconds: number, hz = 440): Buffer {
  const samples = sampleRate * seconds;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.2 * 32767);
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

function extractModel(body: string, contentType: string): string | undefined {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as { model?: unknown };
      return typeof parsed.model === 'string' ? parsed.model : undefined;
    } catch {
      return undefined;
    }
  }
  const match = /name="model"\r?\n\r?\n([^\r\n]+)/.exec(body);
  return match?.[1];
}

function readBody(req: IncomingMessage, max = 25_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
