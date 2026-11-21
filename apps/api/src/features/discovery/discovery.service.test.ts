import type { DiscoveryDocument } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { createTestRuntime, waitUntil } from '../../test-support.ts';
import type { MdnsBrowser, MdnsSighting } from './mdns.ts';

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

async function scan(runtime: ReturnType<typeof createTestRuntime>): Promise<DiscoveryDocument> {
  runtime.discovery.startScan();
  await runtime.discovery.whenIdle();
  return runtime.discovery.document();
}

function targetFor(fake: FakeEcho): Record<string, string> {
  return { DISCOVERY_EXTRA_TARGETS: `${ADDRESS}:${fake.port}` };
}

describe('discovery subnet scan', () => {
  it('finds a FakeEcho through DISCOVERY_EXTRA_TARGETS without subscribing', async () => {
    const fake = await echo();
    ctx = createTestRuntime({ env: targetFor(fake) });

    const document = await scan(ctx);

    expect(document.scanning).toBe(false);
    expect(document.lastScanAt).toEqual(expect.any(String));
    expect(document.found).toHaveLength(1);
    expect(document.found[0]).toMatchObject({
      mac: '020000000001',
      host: ADDRESS,
      port: fake.port,
      nodeName: 'fake-echo',
      friendlyName: 'Echo Dot 2 000001',
      model: 'Echo Dot 2 (biscuit)',
      keyState: 'none',
      source: 'scan',
      addedAs: null,
      movedFrom: null,
      ignored: false,
    });
    // A probe sends Hello + DeviceInfoRequest only: the voice assistant stays free.
    expect(fake.isSubscribed).toBe(false);
    // Its short-lived socket closes; the Echo processes the close a tick later.
    await waitUntil(() => fake.openConnections === 0);
  });

  it('finds a keyed Echo it has no key for, with keyState set', async () => {
    const fake = await echo({ apiKey: KEY });
    ctx = createTestRuntime({ env: targetFor(fake) });

    const document = await scan(ctx);

    expect(document.found[0]).toMatchObject({ mac: '020000000001', keyState: 'set', source: 'scan' });
  });

  it('leaves out a device that answers but has no voice assistant and no key', async () => {
    const fake = await echo({ voiceAssistantFlags: 0 });
    ctx = createTestRuntime({ env: targetFor(fake) });

    expect((await scan(ctx)).found).toEqual([]);
  });

  it('never connects to the host:port of an enabled device', async () => {
    const fake = await echo();
    ctx = createTestRuntime({
      devices: [{ name: 'Kitchen', host: ADDRESS, port: fake.port }],
      env: targetFor(fake),
    });

    const document = await scan(ctx);

    expect(document.found).toEqual([]);
    // Discovery opened no connection at all: the device's own link owns it.
    expect(fake.connectionsAccepted).toBe(0);
  });
});

describe('discovery result model', () => {
  it('marks addedAs by MAC even when the row points at another address', async () => {
    const fake = await echo();
    ctx = createTestRuntime({
      devices: [{ name: 'Kitchen', host: '192.168.9.9', port: 26053, mac: '020000000001', enabled: false }],
      env: targetFor(fake),
    });

    const document = await scan(ctx);

    expect(document.found[0]?.addedAs).toEqual({ id: ctx.created[0]?.id, name: 'Kitchen' });
    expect(document.found[0]?.movedFrom).toBeNull();
  });

  it('marks addedAs by host:port for a row from before the MAC column', async () => {
    const fake = await echo();
    ctx = createTestRuntime({
      devices: [{ name: 'Hall', host: ADDRESS, port: fake.port, mac: null, enabled: false }],
      env: targetFor(fake),
    });

    const document = await scan(ctx);

    expect(document.found[0]?.addedAs).toEqual({ id: ctx.created[0]?.id, name: 'Hall' });
    expect(document.found[0]?.movedFrom).toBeNull();
  });

  it('reports movedFrom when an unconnected device is seen at another address', async () => {
    const fake = await echo();
    ctx = createTestRuntime({
      devices: [{ name: 'Kitchen', host: '192.168.9.9', port: 26053, mac: '020000000001', enabled: true }],
      env: targetFor(fake),
    });

    const document = await scan(ctx);

    expect(document.found[0]?.addedAs).toEqual({ id: ctx.created[0]?.id, name: 'Kitchen' });
    expect(document.found[0]?.movedFrom).toEqual({
      id: ctx.created[0]?.id,
      name: 'Kitchen',
      host: '192.168.9.9',
    });
  });

  it('drops a sighting after 30 minutes and keeps it before then', async () => {
    let clock = 1_000_000;
    const fake = await echo();
    ctx = createTestRuntime({ env: targetFor(fake), discovery: { now: () => clock } });

    await scan(ctx);
    expect(ctx.discovery.document().found).toHaveLength(1);

    clock += 29 * 60 * 1000;
    expect(ctx.discovery.document().found).toHaveLength(1);

    clock += 2 * 60 * 1000;
    expect(ctx.discovery.document().found).toEqual([]);
  });

  it('scans at most once per 60 s, then again after the interval', async () => {
    let clock = 1_000_000;
    const fake = await echo();
    ctx = createTestRuntime({ env: targetFor(fake), discovery: { now: () => clock } });

    await scan(ctx);
    const accepted = fake.connectionsAccepted;
    expect(accepted).toBeGreaterThan(0);

    await scan(ctx);
    expect(fake.connectionsAccepted).toBe(accepted);

    clock += 61_000;
    await scan(ctx);
    expect(fake.connectionsAccepted).toBeGreaterThan(accepted);
  });
});

describe('discovery mDNS', () => {
  function fakeBrowser() {
    const browser: {
      onSighting: (sighting: MdnsSighting) => void;
      onError: (error: unknown) => void;
      stopped: number;
    } = {
      onSighting: () => {},
      onError: () => {},
      stopped: 0,
    };
    const mdns: MdnsBrowser = {
      start(onSighting, onError) {
        browser.onSighting = onSighting;
        browser.onError = onError;
      },
      stop() {
        browser.stopped += 1;
      },
    };
    return { browser, mdns };
  }

  const sighting: MdnsSighting = {
    name: 'fake-echo',
    host: ADDRESS,
    port: 26053,
    mac: '020000000001',
    friendlyName: 'Echo Dot 2 cea6ae',
    keyState: 'none',
  };

  it('records a hassmic sighting and survives multicast errors', () => {
    const { browser, mdns } = fakeBrowser();
    let clock = 1_000_000;
    ctx = createTestRuntime({ discovery: { mdns, now: () => clock } });

    ctx.discovery.start();
    browser.onSighting(sighting);
    const first = ctx.discovery.document();
    expect(first.found[0]).toMatchObject({
      mac: '020000000001',
      host: ADDRESS,
      port: 26053,
      nodeName: 'fake-echo',
      friendlyName: 'Echo Dot 2 cea6ae',
      keyState: 'none',
      source: 'mdns',
      lastSeenAt: new Date(clock).toISOString(),
    });

    // A container without multicast must keep running; the scan still works.
    expect(() => browser.onError(new Error('multicast unavailable'))).not.toThrow();
    expect(() => browser.onError(new Error('still unavailable'))).not.toThrow();
    clock += 1000;
    browser.onSighting(sighting);
    expect(ctx.discovery.document().found).toHaveLength(1);

    ctx.discovery.stop();
    expect(browser.stopped).toBe(1);
  });

  it('marks an Echo seen by both mDNS and the scan as both', async () => {
    const fake = await echo();
    const { browser, mdns } = fakeBrowser();
    ctx = createTestRuntime({
      env: targetFor(fake),
      discovery: { mdns, scanIntervalMs: 0 },
    });

    ctx.discovery.start();
    await ctx.discovery.whenIdle();
    browser.onSighting({ ...sighting, port: fake.port });

    const [found] = ctx.discovery.document().found;
    expect(found).toMatchObject({ mac: '020000000001', source: 'both', port: fake.port });
  });
});
