import { describe, expect, it } from 'vitest';
import { FakeEcho } from '../esphome/fake-echo.ts';
import { MSG } from '../esphome/messages.ts';
import { createTestRuntime } from '../test-support.ts';
import { runDoctor } from './checks.ts';
import { probeEcho } from './probe.ts';

describe('probeEcho', () => {
  it('says hello in plaintext without subscribing to the voice assistant', async () => {
    const echo = new FakeEcho();
    const port = await echo.start();
    try {
      const result = await probeEcho({ host: '127.0.0.1', port, apiKey: null });
      expect(result.problem).toBeUndefined();
      expect(result.reachable).toBe(true);
      expect(result.encryption).toBe('plaintext');
      expect(echo.received.some((message) => message.type === MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST)).toBe(
        false,
      );
    } finally {
      await echo.stop();
    }
  });

  it('accepts a correct key and rejects a wrong one', async () => {
    const key = Buffer.alloc(32, 7);
    const echo = new FakeEcho({ apiKey: key });
    const port = await echo.start();
    try {
      const good = await probeEcho({ host: '127.0.0.1', port, apiKey: key.toString('base64') });
      expect(good.encryption).toBe('noise');
      expect(good.keyAccepted).toBe(true);
      expect(good.problem).toBeUndefined();

      const bad = await probeEcho({
        host: '127.0.0.1',
        port,
        apiKey: Buffer.alloc(32, 8).toString('base64'),
      });
      expect(bad.reachable).toBe(true);
      expect(bad.problem).toBe('invalid-key');
    } finally {
      await echo.stop();
    }
  });

  it('reports an unreachable Echo', async () => {
    const result = await probeEcho({ host: '127.0.0.1', port: 9, apiKey: null, timeoutMs: 1500 });
    expect(result.reachable).toBe(false);
    expect(result.problem).toBe('unreachable');
  });
});

describe('runDoctor', () => {
  it('fails when no Echo is configured, without touching the network', async () => {
    const ctx = createTestRuntime();
    try {
      const report = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: [],
        production: false,
        env: {},
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      expect(report.ok).toBe(false);
      expect(report.checks.find((check) => check.name === 'Echoes')?.status).toBe('fail');
    } finally {
      ctx.sqlite.close();
    }
  });

  it('warns about ignored environment settings and a time-zone mismatch', async () => {
    const ctx = createTestRuntime();
    try {
      ctx.settings.apply({ 'assistant.timeZone': 'Europe/Paris' }, ctx.settings.version);
      const report = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: [],
        production: false,
        env: { TZ: 'Europe/Berlin', OPENAI_TIMEOUT_MS: '30000' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      const envCheck = report.checks.find((check) => check.name === 'environment');
      expect(envCheck?.status).toBe('warn');
      expect(envCheck?.detail).toContain('OPENAI_TIMEOUT_MS');
      expect(envCheck?.detail).toContain('Europe/Berlin');
    } finally {
      ctx.sqlite.close();
    }
  });

  it('serves the same report from GET /api/doctor', async () => {
    const ctx = createTestRuntime();
    try {
      const response = await ctx.app.request('/api/doctor');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; checks: { name: string }[] };
      expect(body.ok).toBe(false);
      expect(body.checks.some((check) => check.name === 'settings')).toBe(true);
    } finally {
      ctx.sqlite.close();
    }
  });
});
