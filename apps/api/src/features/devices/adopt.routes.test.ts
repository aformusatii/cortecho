import type { ApiErrorBody, DeviceStatus, EchoProbeResult } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { createTestRuntime, waitUntil } from '../../test-support.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');
const ADDRESS = '127.0.0.1';

let echoes: FakeEcho[] = [];
let ctx: ReturnType<typeof createTestRuntime>;

async function setup(options: ConstructorParameters<typeof FakeEcho>[0] = {}): Promise<FakeEcho> {
  const echo = new FakeEcho(options);
  await echo.start();
  echoes.push(echo);
  ctx = createTestRuntime({ linkTimeoutMs: 100 });
  await ctx.startDevices();
  return echo;
}

afterEach(async () => {
  await ctx?.runtime.devices.stopAll();
  await Promise.all(echoes.map((echo) => echo.stop()));
  echoes = [];
  ctx?.sqlite.close();
});

const json = <T>(response: Response) => response.json() as Promise<T>;
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /api/devices/probe', () => {
  it('describes an unkeyed Echo without echoing any key', async () => {
    const echo = await setup();
    const response = await ctx.app.request('/api/devices/probe', post({ host: ADDRESS, port: echo.port }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      reachable: true,
      isVoiceAssistant: true,
      nodeName: 'fake-echo',
      mac: '020000000001',
      keyState: 'none',
    } satisfies Partial<EchoProbeResult>);
    expect(body).not.toContain('apiKey');
  });

  it('validates a pasted key and never returns it', async () => {
    const echo = await setup({ apiKey: Buffer.from(KEY, 'base64') });
    const response = await ctx.app.request(
      '/api/devices/probe',
      post({ host: ADDRESS, port: echo.port, apiKey: KEY }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ reachable: true, keyState: 'matches' });
    expect(body).not.toContain(KEY);
  });

  it('refuses an enabled device address and a public host', async () => {
    const echo = await setup();
    const adopted = await json<DeviceStatus>(
      await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, port: echo.port })),
    );
    const refused = await ctx.app.request('/api/devices/probe', post({ host: ADDRESS, port: echo.port }));
    expect(refused.status).toBe(409);
    expect((await json<ApiErrorBody>(refused)).error).toMatchObject({
      code: 'ALREADY_ADDED',
      fields: { deviceId: String(adopted.id), name: adopted.name },
    });

    const publicHost = await ctx.app.request(
      '/api/devices/probe',
      post({ host: '8.8.8.8', port: echo.port }),
    );
    expect(publicHost.status).toBe(400);
    expect((await json<ApiErrorBody>(publicHost)).error.fields).toHaveProperty('host');
  });
});

describe('POST /api/devices/adopt', () => {
  it('adds an Echo and never returns its key', async () => {
    const echo = await setup();
    const response = await ctx.app.request(
      '/api/devices/adopt',
      post({ host: ADDRESS, port: echo.port, name: 'Kitchen' }),
    );
    expect(response.status).toBe(201);
    const body = await response.text();
    const device = JSON.parse(body) as DeviceStatus;
    expect(device).toMatchObject({
      name: 'Kitchen',
      enabled: true,
      hasKey: true,
      encryption: 'noise',
      mac: '020000000001',
      nodeName: 'fake-echo',
    });
    const storedKey = ctx.repository.get(device.id)?.apiKey;
    expect(storedKey).not.toBeNull();
    expect(body).not.toContain(storedKey as string);
    expect(body).not.toContain('apiKey');
  });

  it('refuses a keyed Echo without a key and a wrong pasted key', async () => {
    const echo = await setup({ apiKey: Buffer.from(KEY, 'base64') });
    const keyed = await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, port: echo.port }));
    expect(keyed.status).toBe(409);
    expect((await json<ApiErrorBody>(keyed)).error.code).toBe('ECHO_KEY_SET');

    const wrong = await ctx.app.request(
      '/api/devices/adopt',
      post({ host: ADDRESS, port: echo.port, apiKey: OTHER_KEY }),
    );
    expect(wrong.status).toBe(409);
    const body = await wrong.text();
    expect((JSON.parse(body) as ApiErrorBody).error).toMatchObject({
      code: 'ECHO_KEY_INVALID',
      fields: { apiKey: "This is not the Echo's key." },
    });
    expect(body).not.toContain(OTHER_KEY);
    expect(ctx.repository.count()).toBe(0);
  });

  it('adds an Echo secured by another app with the pasted key', async () => {
    const echo = await setup({ apiKey: Buffer.from(KEY, 'base64') });
    const response = await ctx.app.request(
      '/api/devices/adopt',
      post({ host: ADDRESS, port: echo.port, apiKey: KEY }),
    );
    expect(response.status).toBe(201);
    const body = await response.text();
    expect((JSON.parse(body) as DeviceStatus).hasKey).toBe(true);
    expect(body).not.toContain(KEY);
    expect(echo.setKeyRequests).toBe(0);
  });

  it('answers 409 for an address that is already a device', async () => {
    const echo = await setup();
    const first = await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, port: echo.port }));
    expect(first.status).toBe(201);
    const second = await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, port: echo.port }));
    expect(second.status).toBe(409);
    expect((await json<ApiErrorBody>(second)).error.code).toBe('ALREADY_ADDED');
  });

  it('validates the body', async () => {
    await setup();
    const emptyName = await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, name: '' }));
    expect(emptyName.status).toBe(400);
    expect((await json<ApiErrorBody>(emptyName)).error.fields).toHaveProperty('name');

    const badPort = await ctx.app.request('/api/devices/adopt', post({ host: ADDRESS, port: 0 }));
    expect(badPort.status).toBe(400);
    expect((await json<ApiErrorBody>(badPort)).error.fields).toHaveProperty('port');
  });
});

describe('POST /api/devices/:id/secure', () => {
  it('secures an unkeyed device without returning the key', async () => {
    const echo = await setup();
    const created = await json<DeviceStatus>(
      await ctx.app.request('/api/devices', post({ name: 'Kitchen', host: ADDRESS, port: echo.port })),
    );
    await waitUntil(() => echo.isSubscribed);

    const response = await ctx.app.request(`/api/devices/${created.id}/secure`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect((JSON.parse(body) as DeviceStatus).hasKey).toBe(true);
    const storedKey = ctx.repository.get(created.id)?.apiKey;
    expect(storedKey).not.toBeNull();
    expect(body).not.toContain(storedKey as string);
    expect(body).not.toContain('apiKey');
  });

  it('refuses a device that already has a key and an unknown device', async () => {
    const echo = await setup();
    const created = await json<DeviceStatus>(
      await ctx.app.request(
        '/api/devices',
        post({ name: 'Kitchen', host: ADDRESS, port: echo.port, apiKey: undefined }),
      ),
    );
    await ctx.app.request(`/api/devices/${created.id}/secure`, { method: 'POST' });
    const again = await ctx.app.request(`/api/devices/${created.id}/secure`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await json<ApiErrorBody>(again)).error.code).toBe('ECHO_KEY_SET');

    const unknown = await ctx.app.request('/api/devices/999/secure', { method: 'POST' });
    expect(unknown.status).toBe(404);
  });
});
