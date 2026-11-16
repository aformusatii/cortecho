import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createTurnsRepository } from '../turns/turns.repository.ts';
import { createDevicesRepository, DuplicateDeviceError } from './devices.repository.ts';

function setup() {
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  return { db, sqlite, devices: createDevicesRepository(db) };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});
afterEach(() => ctx.sqlite.close());

const input = {
  name: 'Kitchen',
  kind: 'echo' as const,
  host: '192.168.1.50',
  port: 26053,
  apiKey: null,
  enabled: true,
  prompt: '',
};

describe('devices repository', () => {
  it('creates, lists, edits and deletes a device', () => {
    const created = ctx.devices.create(input);
    expect(created).toMatchObject({ id: 1, name: 'Kitchen', overrides: {}, nodeName: null });
    expect(ctx.devices.count()).toBe(1);
    expect(ctx.devices.list()).toHaveLength(1);

    const updated = ctx.devices.update(created.id, { ...input, name: 'Cuisine', prompt: 'Near the oven.' });
    expect(updated).toMatchObject({ name: 'Cuisine', prompt: 'Near the oven.' });

    expect(ctx.devices.setOverrides(created.id, { 'tts.voice': 'cedar' })?.overrides).toEqual({
      'tts.voice': 'cedar',
    });
    expect(ctx.devices.setNodeName(created.id, 'kitchen-echo')?.nodeName).toBe('kitchen-echo');

    expect(ctx.devices.remove(created.id)).toBe(true);
    expect(ctx.devices.get(created.id)).toBeNull();
    expect(ctx.devices.count()).toBe(0);
  });

  it('reports a duplicate name and a duplicate host:port', () => {
    ctx.devices.create(input);
    expect(() => ctx.devices.create({ ...input, host: '10.0.0.2' })).toThrowError(
      expect.objectContaining({ field: 'name' }),
    );
    try {
      ctx.devices.create({ ...input, name: 'Bedroom' });
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateDeviceError);
      expect((error as DuplicateDeviceError).field).toBe('host');
    }
  });

  it('keeps turns when a device is deleted, with device_id null', () => {
    const device = ctx.devices.create(input);
    const turns = createTurnsRepository(ctx.db);
    const turn = turns.insert({
      source: 'voice',
      outcome: 'answered',
      startedAt: new Date(),
      deviceId: device.id,
      settingsVersion: 3,
      reply: 'hello',
    });
    expect(turns.latest(5)[0]).toMatchObject({
      deviceId: device.id,
      deviceName: 'Kitchen',
      settingsVersion: 3,
    });

    ctx.devices.remove(device.id);
    const [after] = turns.latest(5);
    expect(after).toMatchObject({ id: turn.id, deviceId: null, deviceName: null, reply: 'hello' });
    expect(after?.settingsVersion).toBe(3);
  });

  it('filters turns by device', () => {
    const a = ctx.devices.create(input);
    const b = ctx.devices.create({ ...input, name: 'Bedroom', port: 26054 });
    const turns = createTurnsRepository(ctx.db);
    turns.insert({ source: 'voice', outcome: 'answered', startedAt: new Date(), deviceId: a.id });
    turns.insert({ source: 'voice', outcome: 'answered', startedAt: new Date(), deviceId: b.id });
    turns.insert({ source: 'ask', outcome: 'answered', startedAt: new Date() });
    expect(turns.latest(10, { deviceId: a.id }).map((turn) => turn.deviceName)).toEqual(['Kitchen']);
    expect(turns.latest(10)).toHaveLength(3);
  });
});
