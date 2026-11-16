import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createDevicesRepository } from './devices.repository.ts';
import { importDeviceFromEnvironment } from './import.ts';

function setup() {
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  return { sqlite, devices: createDevicesRepository(db) };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});
afterEach(() => ctx.sqlite.close());

const KEY = Buffer.alloc(32, 3).toString('base64');

describe('device import from the environment', () => {
  it('imports the one Echo once, with its host, port and key', () => {
    const imported = importDeviceFromEnvironment(ctx.devices, {
      ECHO_HOST: '192.168.1.50',
      ECHO_PORT: '26053',
      ECHO_API_KEY: KEY,
    });
    expect(imported).toMatchObject({
      name: 'Echo',
      kind: 'echo',
      host: '192.168.1.50',
      port: 26053,
      apiKey: KEY,
      enabled: true,
      prompt: '',
      overrides: {},
    });
    expect(ctx.devices.count()).toBe(1);

    // Second start: the table is not empty, so nothing happens.
    expect(
      importDeviceFromEnvironment(ctx.devices, { ECHO_HOST: '192.168.1.51', ECHO_PORT: '26053' }),
    ).toBeNull();
    expect(ctx.devices.count()).toBe(1);
  });

  it('does nothing without ECHO_HOST', () => {
    expect(importDeviceFromEnvironment(ctx.devices, {})).toBeNull();
    expect(ctx.devices.count()).toBe(0);
  });

  it('imports a plaintext link when the key is invalid, without failing the start', () => {
    const imported = importDeviceFromEnvironment(ctx.devices, {
      ECHO_HOST: '192.168.1.50',
      ECHO_API_KEY: 'nonsense',
    });
    expect(imported?.apiKey).toBeNull();
  });
});
