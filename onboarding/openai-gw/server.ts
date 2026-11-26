import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/**
 * The only container with internet access. In real mode it is a transparent
 * proxy that replaces the dummy key with OPENAI_API_KEY_E2E; in mock mode it
 * answers deterministically. Bodies, audio, transcripts and keys are never
 * logged or stored: /calls only knows method, path, status, time and model.
 */

const MODE = process.env.OPENAI_MODE ?? 'mock';
const API_KEY = process.env.OPENAI_API_KEY ?? '';
const PORT = 8080;
const UPSTREAM = 'https://api.openai.com';

if (MODE !== 'mock' && MODE !== 'real') {
  console.error(`openai-gw: OPENAI_MODE must be "mock" or "real" (got "${MODE}")`);
  process.exit(1);
}
if (MODE === 'real' && API_KEY.trim() === '') {
  console.error('openai-gw: OPENAI_MODE=real needs OPENAI_API_KEY');
  process.exit(1);
}

type Call = { at: string; method: string; path: string; status: number; ms: number; model?: string };
const calls: Call[] = [];

createServer((req, res) => {
  const startedAt = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://gateway');
  const call: Call = { at: new Date().toISOString(), method, path: url.pathname, status: 0, ms: 0 };
  // Only OpenAI traffic belongs in /calls; health checks and /calls itself
  // would otherwise be noise in the report.
  if (url.pathname.startsWith('/v1/')) calls.push(call);
  res.on('finish', () => {
    call.status = res.statusCode;
    call.ms = Date.now() - startedAt;
  });
  void handle(req, res, method, url.pathname, call).catch((error) => {
    sendJson(res, 502, { error: { message: String(error) } });
  });
}).listen(PORT, '0.0.0.0');

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  call: Call,
): Promise<void> {
  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, mode: MODE });
    return;
  }
  if (method === 'GET' && path === '/calls') {
    sendJson(res, 200, calls);
    return;
  }
  if (!path.startsWith('/v1/')) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }
  if (MODE === 'real') {
    await proxy(req, res, method, path);
    return;
  }
  await mock(req, res, method, path, call);
}

async function proxy(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (['host', 'authorization', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${API_KEY}`);

  const init = { method, headers } as RequestInit & { duplex?: 'half' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as NonNullable<RequestInit['body']>;
    init.duplex = 'half';
  }

  const upstream = await fetch(`${UPSTREAM}${path}`, init);
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

async function mock(
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

/** 1 s of a quiet 440 Hz tone as 16-bit signed LE PCM. */
function tone(sampleRate: number, seconds: number): Buffer {
  const samples = sampleRate * seconds;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2 * 32767);
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
