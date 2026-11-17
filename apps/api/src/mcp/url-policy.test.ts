import { describe, expect, it } from 'vitest';
import { checkAuthorizationServerUrl, checkServerUrl, checkServerUrlResolved } from './url-policy.ts';

describe('connector URL policy', () => {
  it('allows https anywhere and plain http only on the LAN', () => {
    expect(checkServerUrl('https://example.com/mcp').ok).toBe(true);
    expect(checkServerUrl('https://192.168.100.5:8443/mcp').ok).toBe(true);
    expect(checkServerUrl('http://192.168.100.5:8123/api/mcp').ok).toBe(true);
    expect(checkServerUrl('http://10.0.0.2:3000/mcp').ok).toBe(true);
    expect(checkServerUrl('http://172.20.0.3/mcp').ok).toBe(true);
    expect(checkServerUrl('http://127.0.0.1:3000/mcp').ok).toBe(true);
    expect(checkServerUrl('http://localhost:3000/mcp').ok).toBe(true);
  });

  it('refuses public plain HTTP, link-local, multicast, 0.0.0.0 and Echo ports', () => {
    expect(checkServerUrl('http://93.184.216.34/mcp')).toMatchObject({ ok: false, reason: 'public-http' });
    expect(checkServerUrl('http://169.254.169.254/latest')).toMatchObject({
      ok: false,
      reason: 'link-local',
    });
    expect(checkServerUrl('http://224.0.0.1/mcp')).toMatchObject({ ok: false, reason: 'multicast' });
    expect(checkServerUrl('http://0.0.0.0/mcp')).toMatchObject({ ok: false, reason: 'unspecified' });
    expect(checkServerUrl('http://192.168.1.5:26053/mcp')).toMatchObject({ ok: false, reason: 'echo-port' });
    expect(checkServerUrl('https://192.168.1.5:28929/mcp')).toMatchObject({ ok: false, reason: 'echo-port' });
    expect(checkServerUrl('ftp://example.com/mcp')).toMatchObject({ ok: false, reason: 'scheme' });
    expect(checkServerUrl('not a url')).toMatchObject({ ok: false, reason: 'not-a-url' });
  });

  it('checks every resolved address (DNS rebinding)', async () => {
    const metadata = async () => [{ address: '169.254.169.254' }];
    expect(await checkServerUrlResolved('https://evil.example/mcp', metadata)).toMatchObject({
      ok: false,
      reason: 'link-local',
    });
    const publicAddress = async () => [{ address: '93.184.216.34' }];
    expect(await checkServerUrlResolved('http://lan.example/mcp', publicAddress)).toMatchObject({
      ok: false,
      reason: 'public-http',
    });
    const privateAddress = async () => [{ address: '192.168.1.10' }];
    expect(await checkServerUrlResolved('http://lan.example/mcp', privateAddress)).toMatchObject({
      ok: true,
    });
  });

  it('requires https for authorization-server endpoints (loopback exempt)', () => {
    expect(checkAuthorizationServerUrl('https://accounts.example.com').ok).toBe(true);
    expect(checkAuthorizationServerUrl('http://127.0.0.1:9000').ok).toBe(true);
    expect(checkAuthorizationServerUrl('http://accounts.example.com').ok).toBe(false);
  });
});
