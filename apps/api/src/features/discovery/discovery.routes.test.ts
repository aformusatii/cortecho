import type { ApiErrorBody, DiscoveryDocument } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { createTestRuntime } from '../../test-support.ts';

const ADDRESS = '127.0.0.1';
const KEY = Buffer.alloc(32, 7);

let ctx: ReturnType<typeof createTestRuntime> | null = null;
let echoes: FakeEcho[] = [];

async function echo(options: ConstructorParameters<typeof FakeEcho>[0] = {}): Promise<FakeEcho> {
  const fake = new FakeEcho(options);
  await fake.start();
  echoes.push(fake);
  return fake;
}

afterEach(async () => {
  ctx?.discovery.stop();
  ctx?.sqlite.close();
  ctx = null;
  await Promise.all(echoes.map((fake) => fake.stop()));
  echoes = [];
});

const json = <T>(response: Response) => response.json() as Promise<T>;
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('GET /api/discovery', () => {
  it('returns an empty document before any scan', async () => {
    ctx = createTestRuntime();
    const response = await ctx.app.request('/api/discovery');
    expect(response.status).toBe(200);
    expect(await json<DiscoveryDocument>(response)).toEqual({
      scanning: false,
      lastScanAt: null,
      found: [],
    });
  });
});

describe('POST /api/discovery/scan', () => {
  it('accepts hints and answers 202 with the document', async () => {
    ctx = createTestRuntime();
    const response = await ctx.app.request('/api/discovery/scan', post({ hints: ['192.168.1.10'] }));
    expect(response.status).toBe(202);
    const document = await json<DiscoveryDocument>(response);
    expect(document).toMatchObject({ found: [] });
    expect(document).toHaveProperty('scanning');
    expect(document).toHaveProperty('lastScanAt');
  });

  it('accepts an empty body object and rejects malformed hints', async () => {
    ctx = createTestRuntime();
    expect((await ctx.app.request('/api/discovery/scan', post({}))).status).toBe(202);

    const bad = await ctx.app.request('/api/discovery/scan', post({ hints: '192.168.1.10' }));
    expect(bad.status).toBe(400);
    const body = await json<ApiErrorBody>(bad);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toHaveProperty('hints');

    const tooMany = await ctx.app.request(
      '/api/discovery/scan',
      post({ hints: Array.from({ length: 9 }, (_, index) => `192.168.1.${index}`) }),
    );
    expect(tooMany.status).toBe(400);
  });
});

describe('POST /api/discovery/ignore and DELETE /api/discovery/ignore/:mac', () => {
  it('ignores and unignores by MAC, idempotently', async () => {
    const fake = await echo();
    ctx = createTestRuntime({ env: { DISCOVERY_EXTRA_TARGETS: `${ADDRESS}:${fake.port}` } });
    ctx.discovery.startScan();
    await ctx.discovery.whenIdle();

    const ignored = await ctx.app.request('/api/discovery/ignore', post({ mac: '02:00:00:00:00:01' }));
    expect(ignored.status).toBe(204);
    expect((await json<DiscoveryDocument>(await ctx.app.request('/api/discovery'))).found[0]?.ignored).toBe(
      true,
    );

    // A second Ignore is a no-op, not an error.
    expect((await ctx.app.request('/api/discovery/ignore', post({ mac: '020000000001' }))).status).toBe(204);

    const unignored = await ctx.app.request('/api/discovery/ignore/020000000001', { method: 'DELETE' });
    expect(unignored.status).toBe(204);
    expect((await json<DiscoveryDocument>(await ctx.app.request('/api/discovery'))).found[0]?.ignored).toBe(
      false,
    );
  });

  it('validates the MAC on both routes', async () => {
    ctx = createTestRuntime();
    const ignored = await ctx.app.request('/api/discovery/ignore', post({ mac: 'nope' }));
    expect(ignored.status).toBe(400);
    expect((await json<ApiErrorBody>(ignored)).error.fields).toHaveProperty('mac');

    const removed = await ctx.app.request('/api/discovery/ignore/nope', { method: 'DELETE' });
    expect(removed.status).toBe(400);
    expect((await json<ApiErrorBody>(removed)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('discovery responses', () => {
  it('never contains a device key and is not affected by a keyed Echo', async () => {
    const fake = await echo({ apiKey: KEY });
    ctx = createTestRuntime({ env: { DISCOVERY_EXTRA_TARGETS: `${ADDRESS}:${fake.port}` } });

    const scanResponse = await ctx.app.request('/api/discovery/scan', post({}));
    const scanBody = await scanResponse.text();
    expect(scanBody).not.toContain(KEY.toString('base64'));

    ctx.discovery.startScan();
    await ctx.discovery.whenIdle();
    const document = await (await ctx.app.request('/api/discovery')).text();
    expect(document).not.toContain(KEY.toString('base64'));
    expect(document).not.toContain('apiKey');
    expect(JSON.parse(document)).toMatchObject({
      found: [expect.objectContaining({ keyState: 'set' })],
    });
  });
});
