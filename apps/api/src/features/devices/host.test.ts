import { describe, expect, it } from 'vitest';
import { checkHost, isPrivateIpv4, resolveHost } from './host.ts';

describe('device host validation', () => {
  it('accepts RFC 1918 and loopback literals', () => {
    for (const address of [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.50',
      '127.0.0.1',
    ]) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
  });

  it('refuses public, link-local, multicast, 0.0.0.0 and malformed addresses', () => {
    for (const address of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '255.255.255.255',
      '0.0.0.0',
      '1.2.3',
      'example.com',
    ]) {
      expect(isPrivateIpv4(address), address).toBe(false);
    }
  });

  it('reports a clear message and never lets a name resolve to the internet', async () => {
    expect(await checkHost('192.168.1.20')).toEqual({ ok: true });
    expect(await checkHost('127.0.0.1')).toEqual({ ok: true });
    expect(await checkHost('8.8.8.8')).toMatchObject({
      ok: false,
      message: expect.stringContaining('8.8.8.8'),
    });
    expect(await checkHost('169.254.1.1')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Link-local'),
    });
    expect(await checkHost('::1')).toMatchObject({ ok: false, message: expect.stringContaining('IPv6') });
    expect(await checkHost('does-not-exist.invalid')).toMatchObject({ ok: false });
  });

  it('resolves an allowed host to the literal to connect to', async () => {
    expect(await resolveHost('127.0.0.1')).toBe('127.0.0.1');
    expect(await resolveHost('10.1.2.3')).toBe('10.1.2.3');
    expect(await resolveHost('8.8.8.8')).toBeNull();
    expect(await resolveHost('localhost')).toMatch(/^127\./);
  });
});
