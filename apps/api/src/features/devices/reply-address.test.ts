import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime> | null = null;

afterEach(() => {
  ctx?.sqlite.close();
  ctx = null;
});

describe('reply-address-missing', () => {
  it('is reported for an enabled Echo in production while the setting is empty', () => {
    ctx = createTestRuntime({ devices: [{ name: 'Kitchen', port: 26053 }], production: true });
    expect(ctx.runtime.devices.list()[0]?.problem).toBe('reply-address-missing');

    ctx.settings.apply({ 'network.replyBaseUrl': 'http://192.168.1.10:3000' }, ctx.settings.version);
    expect(ctx.runtime.devices.list()[0]?.problem).not.toBe('reply-address-missing');
  });

  it('is not reported in development, for a disabled Echo, or for a test device', () => {
    ctx = createTestRuntime({ devices: [{ name: 'Kitchen', port: 26053 }] });
    expect(ctx.runtime.devices.list()[0]?.problem).toBeNull();

    ctx.sqlite.close();
    ctx = createTestRuntime({
      devices: [
        { name: 'Off', port: 26054, enabled: false },
        { name: 'Test', port: 26055, kind: 'test' },
      ],
      production: true,
    });
    expect(ctx.runtime.devices.list().map((device) => device.problem)).toEqual([null, null]);
  });
});
