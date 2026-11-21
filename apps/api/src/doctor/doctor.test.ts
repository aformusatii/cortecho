import type { EchoProbeResult } from '@cortecho/shared';
import { describe, expect, it } from 'vitest';
import { FakeEcho } from '../esphome/fake-echo.ts';
import { createTestRuntime } from '../test-support.ts';
import { runDoctor } from './checks.ts';

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

  it('reports an Echo that requires a key the device does not have', async () => {
    const fake = new FakeEcho({ apiKey: Buffer.alloc(32, 7) });
    const port = await fake.start();
    const ctx = createTestRuntime({ devices: [{ name: 'Kitchen', port }] });
    try {
      const report = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: ctx.repository.list(),
        production: false,
        env: {},
        fetchImpl: async () => new Response('[]', { status: 200 }),
      });
      const echoCheck = report.checks.find((check) => check.name === 'Echo Kitchen');
      expect(echoCheck?.status).toBe('fail');
      expect(echoCheck?.detail).toContain('requires an API key');
    } finally {
      await fake.stop();
      ctx.sqlite.close();
    }
  });

  it('reports the reply address from the setting, and fails in production without one', async () => {
    const ctx = createTestRuntime({ devices: [{ name: 'Kitchen', port: 26053 }], production: true });
    try {
      const failing = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: ctx.repository.list(),
        production: true,
        env: {},
        probe: async (): Promise<EchoProbeResult> => ({ reachable: false, code: 'unreachable' }),
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      const missing = failing.checks.find((check) => check.name === 'reply address');
      expect(missing?.status).toBe('fail');
      expect(missing?.fix).toContain('Settings → Network');

      ctx.settings.apply({ 'network.replyBaseUrl': 'http://192.168.1.10:3000' }, ctx.settings.version);
      const passing = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: ctx.repository.list(),
        production: true,
        env: {},
        probe: async (): Promise<EchoProbeResult> => ({ reachable: false, code: 'unreachable' }),
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      expect(passing.checks.find((check) => check.name === 'reply address')).toMatchObject({
        status: 'pass',
        detail: expect.stringContaining('http://192.168.1.10:3000'),
      });
    } finally {
      ctx.sqlite.close();
    }
  });

  it('does not list REPLY_AUDIO_BASE_URL as ignored until it is stored', async () => {
    const ctx = createTestRuntime();
    try {
      const before = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: [],
        production: false,
        env: { REPLY_AUDIO_BASE_URL: 'http://192.168.1.10:3000' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      expect(before.checks.find((check) => check.name === 'environment')?.status).toBe('pass');

      ctx.settings.apply({ 'network.replyBaseUrl': 'http://192.168.1.10:3000' }, ctx.settings.version);
      const after = await runDoctor({
        config: ctx.runtime.config,
        settings: ctx.settings,
        devices: [],
        production: false,
        env: { REPLY_AUDIO_BASE_URL: 'http://192.168.1.10:3000' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      expect(after.checks.find((check) => check.name === 'environment')?.detail).toContain(
        'REPLY_AUDIO_BASE_URL',
      );
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
