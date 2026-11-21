import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeEcho, setKeyOnUnkeyedEcho } from './adopt.ts';
import { FakeEcho } from './fake-echo.ts';
import { MSG, VA_FEATURE } from './messages.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');

let echoes: FakeEcho[] = [];
let servers: net.Server[] = [];
let rawSockets: net.Socket[] = [];

async function echo(options: ConstructorParameters<typeof FakeEcho>[0] = {}): Promise<FakeEcho> {
  const fake = new FakeEcho(options);
  await fake.start();
  echoes.push(fake);
  return fake;
}

/** A TCP server that accepts and then does something on each socket. */
async function rawServer(onSocket: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    rawSockets.push(socket);
    socket.on('error', () => {});
    onSocket(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return address.port;
}

afterEach(async () => {
  await Promise.all(echoes.map((fake) => fake.stop()));
  echoes = [];
  for (const socket of rawSockets) socket.destroy();
  rawSockets = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

describe('probeEcho', () => {
  it('reads an unkeyed Echo in plaintext without subscribing to the voice assistant', async () => {
    const fake = await echo();
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port });
    expect(result).toEqual({
      reachable: true,
      isVoiceAssistant: true,
      nodeName: 'fake-echo',
      mac: '020000000001',
      friendlyName: 'Echo Dot 2 000001',
      model: 'Echo Dot 2 (biscuit)',
      keyState: 'none',
    });
    expect(fake.received.some((message) => message.type === MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST)).toBe(
      false,
    );
  });

  it('does not mistake an ESPHome device without a voice assistant for an Echo', async () => {
    const fake = await echo({ voiceAssistantFlags: VA_FEATURE.API_AUDIO });
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port });
    expect(result.reachable && result.isVoiceAssistant).toBe(false);
  });

  it('accepts the Echo key and reports a match', async () => {
    const fake = await echo({ apiKey: Buffer.from(KEY, 'base64') });
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port, apiKey: KEY });
    expect(result).toMatchObject({
      reachable: true,
      keyState: 'matches',
      nodeName: 'fake-echo',
      mac: '020000000001',
    });
  });

  it('reads the identity of a keyed Echo from the Noise hello when no key is given', async () => {
    const fake = await echo({ apiKey: Buffer.from(KEY, 'base64') });
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port });
    expect(result).toEqual({
      reachable: true,
      isVoiceAssistant: null,
      nodeName: 'fake-echo',
      mac: '020000000001',
      friendlyName: null,
      model: null,
      keyState: 'set',
    });
  });

  it('reports "set" for a wrong key', async () => {
    const fake = await echo({ apiKey: Buffer.from(KEY, 'base64') });
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port, apiKey: OTHER_KEY });
    expect(result).toMatchObject({ reachable: true, keyState: 'set', mac: '020000000001' });
  });

  it('never throws for a malformed stored key', async () => {
    const fake = await echo({ apiKey: Buffer.from(KEY, 'base64') });
    const result = await probeEcho({ host: '127.0.0.1', port: fake.port, apiKey: 'not-a-key' });
    expect(result).toMatchObject({ reachable: true, keyState: 'set' });
  });

  it('reports an unreachable address', async () => {
    const result = await probeEcho({ host: '127.0.0.1', port: 9, timeoutMs: 1500 });
    expect(result).toEqual({ reachable: false, code: 'unreachable' });
  });

  it('reports a device that closes without answering as not an ESPHome device', async () => {
    const port = await rawServer((socket) => socket.destroy());
    const result = await probeEcho({ host: '127.0.0.1', port, timeoutMs: 1500 });
    expect(result).toEqual({ reachable: false, code: 'not-esphome' });
  });

  it('times out on a device that accepts and stays silent', async () => {
    const port = await rawServer(() => {});
    const result = await probeEcho({ host: '127.0.0.1', port, timeoutMs: 150 });
    expect(result).toEqual({ reachable: false, code: 'timeout' });
  });
});

describe('setKeyOnUnkeyedEcho', () => {
  it('refuses to send an empty key', async () => {
    const fake = await echo();
    await expect(setKeyOnUnkeyedEcho({ host: '127.0.0.1', port: fake.port, key: '' })).rejects.toThrow(
      /empty key/,
    );
    expect(fake.connectionsAccepted).toBe(0);
  });

  it('sets the key on an unkeyed Echo and reports the name', async () => {
    const fake = await echo();
    const names: string[] = [];
    const outcome = await setKeyOnUnkeyedEcho({
      host: '127.0.0.1',
      port: fake.port,
      key: KEY,
      onHello: (name) => names.push(name),
    });
    expect(outcome).toBe('ok');
    expect(fake.apiKey?.toString('base64')).toBe(KEY);
    expect(names).toEqual(['fake-echo']);
    expect(fake.setKeyRequests).toBe(1);
  });

  it('is refused by an Echo that already has a key', async () => {
    const fake = await echo({ apiKey: Buffer.from(KEY, 'base64') });
    expect(await setKeyOnUnkeyedEcho({ host: '127.0.0.1', port: fake.port, key: OTHER_KEY })).toBe('refused');
    expect(fake.apiKey?.toString('base64')).toBe(KEY);
    expect(fake.setKeyRequests).toBe(0);
  });

  it('reports "unreachable" when nothing was sent', async () => {
    expect(await setKeyOnUnkeyedEcho({ host: '127.0.0.1', port: 9, key: KEY })).toBe('unreachable');
  });

  it('reports "lost" when the answer is dropped after the key was stored', async () => {
    const fake = await echo({ loseSetKeyResponses: 1, storeKeyWhenLost: true });
    expect(await setKeyOnUnkeyedEcho({ host: '127.0.0.1', port: fake.port, key: KEY })).toBe('lost');
    expect(fake.apiKey?.toString('base64')).toBe(KEY);
  });

  it('reports "lost" when the answer is dropped before the key was stored', async () => {
    const fake = await echo({ loseSetKeyResponses: 1 });
    expect(await setKeyOnUnkeyedEcho({ host: '127.0.0.1', port: fake.port, key: KEY })).toBe('lost');
    expect(fake.apiKey).toBeNull();
  });
});
