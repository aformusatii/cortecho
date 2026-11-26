import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EchoHost } from './echo-host.ts';

/** The small JSON control surface the Playwright runner and the report use. */
export function createControlServer(host: EchoHost, fixturePcm: Buffer, port: number): Server {
  return createServer((req, res) => {
    void handle(host, fixturePcm, req, res).catch((error) => {
      sendJson(res, 500, { error: String(error) });
    });
  }).listen(port, '0.0.0.0');
}

async function handle(
  host: EchoHost,
  fixturePcm: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://echo');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'GET' && url.pathname === '/state') {
    sendJson(res, 200, host.state());
    return;
  }
  if (method === 'POST' && url.pathname === '/wake') {
    const body = await readBody(req);
    const fixture = parseFixture(body);
    if (fixture !== 'what-time-is-it') {
      sendJson(res, 400, { error: `unknown fixture "${fixture}"` });
      return;
    }
    try {
      const run = host.wake(fixturePcm);
      sendJson(res, 200, { runId: run.id });
    } catch (error) {
      sendJson(res, 409, { error: String(error) });
    }
    return;
  }
  if (method === 'GET' && parts[0] === 'runs' && parts[1]) {
    const id = Number(parts[1]);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(res, 400, { error: 'run id must be a positive integer' });
      return;
    }
    const run = host.run(id);
    if (!run) {
      sendJson(res, 404, { error: `no run ${id}` });
      return;
    }
    sendJson(res, 200, run);
    return;
  }
  if (method === 'GET' && parts[0] === 'media' && parts[1]) {
    const n = Number(parts[1]);
    const bytes = Number.isInteger(n) && n > 0 ? host.mediaBytes(n) : null;
    if (!bytes) {
      sendJson(res, 404, { error: `no media ${parts[1]}` });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    res.end(bytes);
    return;
  }
  if (method === 'POST' && url.pathname === '/drop') {
    host.drop();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && url.pathname === '/reboot') {
    try {
      await host.reboot();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 409, { error: String(error) });
    }
    return;
  }
  sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

function parseFixture(body: string): string {
  if (body.trim() === '') return 'what-time-is-it';
  try {
    const parsed = JSON.parse(body) as { fixture?: unknown };
    return typeof parsed.fixture === 'string' ? parsed.fixture : 'what-time-is-it';
  } catch {
    return 'what-time-is-it';
  }
}

function readBody(req: IncomingMessage, max = 100_000): Promise<string> {
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
