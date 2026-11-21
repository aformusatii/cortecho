import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { expandTargets, mapLimit, subnet24, tcpConnect } from './subnet.ts';

describe('subnet24', () => {
  it('returns the 254 usable addresses of an IPv4 /24', () => {
    const addresses = subnet24('192.168.1.77');
    expect(addresses).toHaveLength(254);
    expect(addresses?.[0]).toBe('192.168.1.1');
    expect(addresses?.[253]).toBe('192.168.1.254');
    expect(subnet24('example.com')).toBeNull();
    expect(subnet24('::1')).toBeNull();
  });
});

describe('expandTargets', () => {
  it('expands private hints to their /24 on the API port and drops public ones', async () => {
    const targets = await expandTargets({
      hints: ['192.168.1.77', '192.168.1.80', '8.8.8.8', '', '::1'],
      extraTargets: [],
    });
    expect(targets).toHaveLength(254);
    expect(targets.every((target) => target.port === 26053)).toBe(true);
    expect(targets.some((target) => target.host === '192.168.1.77')).toBe(true);
    expect(targets.some((target) => target.host === '8.8.8.8')).toBe(false);
  });

  it('keeps extra targets and their own ports, and only private addresses', async () => {
    const targets = await expandTargets({
      hints: [],
      extraTargets: [
        { host: '127.0.0.1', port: 26099 },
        { host: '10.0.0.5', port: 3000 },
        { host: '8.8.8.8', port: 26053 },
      ],
    });
    expect(targets).toEqual([
      { host: '127.0.0.1', port: 26099 },
      { host: '10.0.0.5', port: 3000 },
    ]);
  });

  it('resolves host names and URL hints to a private /24, and only resolves names', async () => {
    const resolved: string[] = [];
    const targets = await expandTargets({
      hints: ['router.lan', 'http://192.168.9.10:3000', 'does-not-resolve.lan'],
      extraTargets: [],
      resolve: async (host) => {
        resolved.push(host);
        return host === 'router.lan' ? '10.0.0.5' : null;
      },
    });
    expect(resolved).toEqual(['router.lan', 'does-not-resolve.lan']);
    // Two different /24s: the name hint's and the URL hint's.
    expect(targets).toHaveLength(508);
    expect(new Set(targets.map((target) => target.host.split('.').slice(0, 3).join('.')))).toEqual(
      new Set(['10.0.0', '192.168.9']),
    );
  });
});

describe('mapLimit', () => {
  it('preserves order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 4, 2, 3], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 2;
    });
    expect(results).toEqual([10, 2, 8, 4, 6]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async (value) => value)).toEqual([]);
  });
});

describe('tcpConnect', () => {
  it('is true for a listening port and false for a closed one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await tcpConnect('127.0.0.1', port, 400)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await tcpConnect('127.0.0.1', port, 400)).toBe(false);
  });
});
