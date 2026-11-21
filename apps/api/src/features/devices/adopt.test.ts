import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { MSG } from '../../esphome/messages.ts';
import { ProtoMessage } from '../../esphome/protobuf.ts';
import { createTestRuntime, type TestDevice, waitUntil } from '../../test-support.ts';
import type { Device } from './devices.repository.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');
const ADDRESS = '127.0.0.1';

let echoes: FakeEcho[] = [];
let ctx: ReturnType<typeof createTestRuntime>;

async function start(options: ConstructorParameters<typeof FakeEcho>[0] = {}): Promise<FakeEcho> {
  const echo = new FakeEcho(options);
  await echo.start();
  echoes.push(echo);
  return echo;
}

function runtime(devices?: TestDevice[], linkTimeoutMs = 100) {
  ctx = createTestRuntime({ devices, linkTimeoutMs });
  return ctx;
}

afterEach(async () => {
  await ctx?.runtime.devices.stopAll();
  await Promise.all(echoes.map((echo) => echo.stop()));
  echoes = [];
  ctx?.sqlite.close();
});

const adopt = (port: number, extra: { name?: string; apiKey?: string } = {}) =>
  ctx.devices.adopt({ host: ADDRESS, port, kind: 'echo', ...extra });

const rowOf = (device: Device): Device | null => ctx.repository.get(device.id);

describe('DeviceManager.adopt', () => {
  it('adds an unkeyed Echo, secures it and connects with the generated key', async () => {
    const echo = await start();
    runtime();
    await ctx.startDevices();

    const device = await adopt(echo.port);
    expect(device).toMatchObject({
      name: 'Echo Dot 2 000001',
      kind: 'echo',
      enabled: true,
      host: ADDRESS,
      port: echo.port,
      nodeName: 'fake-echo',
      mac: '020000000001',
    });
    expect(device.apiKey).not.toBeNull();
    expect(echo.apiKey?.toString('base64')).toBe(device.apiKey);
    expect(ctx.devices.status(device)).toMatchObject({
      hasKey: true,
      encryption: 'noise',
      state: 'connected',
      problem: null,
    });
    expect(echo.setKeyRequests).toBe(1);
    // Probes, SetKey and the link never overlap: one connection at a time.
    expect(echo.maxOpenConnections).toBe(1);
  });

  it('stores the key on a disabled row before SetKey is sent', async () => {
    const echo = await start();
    runtime();
    await ctx.startDevices();

    let rows: { apiKey: string | null; enabled: boolean }[] = [];
    let sentKey: string | null = null;
    echo.on('message', (message) => {
      if (message.type !== MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST) return;
      rows = ctx.repository.list().map((device) => ({ apiKey: device.apiKey, enabled: device.enabled }));
      sentKey = new ProtoMessage(message.payload).string(1);
    });

    await adopt(echo.port);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.apiKey).not.toBeNull();
    expect(sentKey).toBe(rows[0]?.apiKey);
  });

  it('recovers when the SetKey answer is lost but the Echo stored the key', async () => {
    const echo = await start({ loseSetKeyResponses: 1, storeKeyWhenLost: true });
    runtime();
    await ctx.startDevices();

    const device = await adopt(echo.port);
    expect(echo.setKeyRequests).toBe(1);
    expect(echo.apiKey?.toString('base64')).toBe(device.apiKey);
    expect(ctx.devices.status(device).encryption).toBe('noise');
  });

  it('retries SetKey once when the lost answer did not store the key', async () => {
    const echo = await start({ loseSetKeyResponses: 1 });
    runtime();
    await ctx.startDevices();

    const device = await adopt(echo.port);
    expect(echo.setKeyRequests).toBe(2);
    expect(echo.apiKey?.toString('base64')).toBe(device.apiKey);
    expect(echo.maxOpenConnections).toBe(1);
  });

  it('fails without a row when the Echo never takes the key', async () => {
    const echo = await start({ loseSetKeyResponses: 2 });
    runtime();
    await ctx.startDevices();

    await expect(adopt(echo.port)).rejects.toMatchObject({ code: 'ADOPT_FAILED', status: 502 });
    expect(ctx.repository.count()).toBe(0);
    // The Echo is reachable and provably unkeyed: deleting the row loses no key.
    expect(echo.apiKey).toBeNull();
  });

  it('keeps the row when a lost SetKey answer cannot be verified', async () => {
    const echo = await start({ loseSetKeyResponses: 1, storeKeyWhenLost: true });
    runtime();
    await ctx.startDevices();
    // The Echo reboots right after storing the key: the follow-up probe cannot reach it.
    echo.on('message', (message) => {
      if (message.type === MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST) void echo.stop();
    });

    const device = await adopt(echo.port);
    const stored = rowOf(device);
    expect(stored?.apiKey).not.toBeNull();
    expect(echo.apiKey?.toString('base64')).toBe(stored?.apiKey);
    expect(stored?.enabled).toBe(true);
    // Nothing answers any more, so the status says so instead of failing.
    expect(ctx.devices.status(stored as Device).state).not.toBe('connected');
  });

  it('refuses an Echo that already has a key it was not given', async () => {
    const echo = await start({ apiKey: Buffer.from(KEY, 'base64') });
    runtime();
    await ctx.startDevices();

    await expect(adopt(echo.port)).rejects.toMatchObject({ code: 'ECHO_KEY_SET', status: 409 });
    expect(ctx.repository.count()).toBe(0);
  });

  it('adopts an Echo secured by another app with the pasted key', async () => {
    const echo = await start({ apiKey: Buffer.from(KEY, 'base64') });
    runtime();
    await ctx.startDevices();

    const device = await adopt(echo.port, { apiKey: KEY });
    expect(device.apiKey).toBe(KEY);
    expect(echo.setKeyRequests).toBe(0);
    expect(ctx.devices.status(device)).toMatchObject({ encryption: 'noise', state: 'connected' });
  });

  it('refuses a wrong pasted key with a field error', async () => {
    const echo = await start({ apiKey: Buffer.from(KEY, 'base64') });
    runtime();
    await ctx.startDevices();

    await expect(adopt(echo.port, { apiKey: OTHER_KEY })).rejects.toMatchObject({
      code: 'ECHO_KEY_INVALID',
      status: 409,
      fields: { apiKey: "This is not the Echo's key." },
    });
    expect(ctx.repository.count()).toBe(0);
  });

  it('refuses an address that is already a device, without connecting', async () => {
    const echo = await start();
    runtime([{ name: 'Kitchen', port: echo.port, enabled: false }]);

    await expect(adopt(echo.port)).rejects.toMatchObject({
      code: 'ALREADY_ADDED',
      status: 409,
      fields: { deviceId: '1', name: 'Kitchen' },
    });
    expect(echo.connectionsAccepted).toBe(0);
  });

  it('refuses a MAC that another row already has', async () => {
    const echo = await start();
    runtime([{ name: 'Kitchen', port: 1, mac: '02:00:00:00:00:01', enabled: false }]);

    await expect(adopt(echo.port)).rejects.toMatchObject({ code: 'ALREADY_ADDED', status: 409 });
    expect(ctx.repository.count()).toBe(1);
  });

  it('lets only one adoption per address run at a time', async () => {
    const echo = await start();
    runtime();
    await ctx.startDevices();

    const first = adopt(echo.port);
    await expect(adopt(echo.port)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    const device = await first;
    expect(device.enabled).toBe(true);
    expect(echo.setKeyRequests).toBe(1);
  });

  it('reports an unreachable Echo and a device without a voice assistant', async () => {
    runtime();
    await ctx.startDevices();
    await expect(adopt(9)).rejects.toMatchObject({ code: 'ECHO_UNREACHABLE', status: 502 });

    const plain = await start({ voiceAssistantFlags: 0 });
    await expect(adopt(plain.port)).rejects.toMatchObject({ code: 'NOT_AN_ECHO', status: 409 });
    expect(ctx.repository.count()).toBe(0);
  });

  it('makes the adopted name unique and takes the requested one', async () => {
    const echo = await start();
    runtime([{ name: 'Echo Dot 2 000001', port: 1, enabled: false }]);
    await ctx.startDevices();

    const device = await adopt(echo.port);
    expect(device.name).toBe('Echo Dot 2 000001 2');
  });

  it('uses the name from the request', async () => {
    const echo = await start();
    runtime();
    await ctx.startDevices();

    const device = await adopt(echo.port, { name: 'Kitchen' });
    expect(device.name).toBe('Kitchen');
  });
});

describe('DeviceManager.secure', () => {
  it('secures an existing unkeyed row and reconnects with the key', async () => {
    const echo = await start();
    runtime([{ name: 'Kitchen', port: echo.port }]);
    await ctx.startDevices();
    await waitUntil(() => echo.isSubscribed);
    const id = ctx.created[0]?.id as number;

    const secured = await ctx.devices.secure(id);
    const row = rowOf(secured);
    expect(row?.apiKey).not.toBeNull();
    expect(echo.apiKey?.toString('base64')).toBe(row?.apiKey);
    expect(echo.maxOpenConnections).toBe(1);
    await waitUntil(() => ctx.devices.status(row as Device).state === 'connected');
    expect(ctx.devices.status(row as Device).encryption).toBe('noise');
  });

  it('refuses a row that already has a key', async () => {
    const echo = await start({ apiKey: Buffer.from(KEY, 'base64') });
    runtime([{ name: 'Kitchen', port: echo.port, apiKey: KEY, enabled: false }]);
    const id = ctx.created[0]?.id as number;

    await expect(ctx.devices.secure(id)).rejects.toMatchObject({ code: 'ECHO_KEY_SET', status: 409 });
    expect(echo.setKeyRequests).toBe(0);
  });

  it('refuses an Echo secured by another app and keeps the row plaintext', async () => {
    const echo = await start({ apiKey: Buffer.from(KEY, 'base64') });
    runtime([{ name: 'Kitchen', port: echo.port }]);
    const id = ctx.created[0]?.id as number;

    await expect(ctx.devices.secure(id)).rejects.toMatchObject({ code: 'ECHO_KEY_SET', status: 409 });
    expect(ctx.repository.get(id)?.apiKey).toBeNull();
    expect(echo.setKeyRequests).toBe(0);
  });

  it('keeps the key when a lost SetKey answer cannot be verified', async () => {
    const echo = await start({ loseSetKeyResponses: 1, storeKeyWhenLost: true });
    runtime([{ name: 'Kitchen', port: echo.port }]);
    await ctx.startDevices();
    await waitUntil(() => echo.isSubscribed);
    const id = ctx.created[0]?.id as number;
    echo.on('message', (message) => {
      if (message.type === MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST) void echo.stop();
    });

    const secured = await ctx.devices.secure(id);
    const row = rowOf(secured);
    expect(row?.apiKey).not.toBeNull();
    expect(echo.apiKey?.toString('base64')).toBe(row?.apiKey);
  });

  it('reverts the row and reconnects when the Echo provably did not take the key', async () => {
    const echo = await start({ loseSetKeyResponses: 2 });
    runtime([{ name: 'Kitchen', port: echo.port }]);
    await ctx.startDevices();
    await waitUntil(() => echo.isSubscribed);
    const id = ctx.created[0]?.id as number;

    await expect(ctx.devices.secure(id)).rejects.toMatchObject({ code: 'ADOPT_FAILED', status: 502 });
    expect(ctx.repository.get(id)?.apiKey).toBeNull();
    await waitUntil(() => echo.isSubscribed);
  });
});
