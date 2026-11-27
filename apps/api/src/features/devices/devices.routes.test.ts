import type {
  ApiErrorBody,
  DeviceSettingsDocument,
  DeviceStatus,
  InstructionsDocument,
} from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime>;

function setup() {
  ctx = createTestRuntime();
  return ctx.app;
}

afterEach(() => ctx?.sqlite.close());

const json = <T>(response: Response) => response.json() as Promise<T>;

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const KEY = Buffer.alloc(32, 7).toString('base64');

const input = {
  name: 'Kitchen',
  host: '192.168.1.50',
  port: 26053,
};

describe('devices API', () => {
  it('creates a device and never returns its key', async () => {
    const app = setup();
    const created = await app.request('/api/devices', post({ ...input, apiKey: KEY }));
    expect(created.status).toBe(201);
    const body = await created.text();
    const device = JSON.parse(body) as DeviceStatus;
    expect(device).toMatchObject({
      name: 'Kitchen',
      host: '192.168.1.50',
      port: 26053,
      hasKey: true,
      encryption: 'noise',
      enabled: true,
      state: 'disconnected',
      problem: null,
      mac: null,
      overrideCount: 0,
    });
    expect(body).not.toContain(KEY);

    const list = await app.request('/api/devices');
    const listBody = await list.text();
    expect(listBody).not.toContain(KEY);
    expect(JSON.parse(listBody)).toHaveLength(1);

    const health = await app.request('/api/health');
    const healthBody = await health.text();
    expect(healthBody).not.toContain(KEY);
    expect(JSON.parse(healthBody).devices).toHaveLength(1);
  });

  it('creates plaintext devices without a key and clears a key with null', async () => {
    const app = setup();
    const created = await json<DeviceStatus>(
      await app.request('/api/devices', post({ ...input, apiKey: KEY })),
    );
    expect(created.encryption).toBe('noise');
    const cleared = await app.request(`/api/devices/${created.id}`, patch({ apiKey: null }));
    expect(await json<DeviceStatus>(cleared)).toMatchObject({ hasKey: false, encryption: 'plaintext' });
    // Absent keeps the (now empty) key.
    const kept = await app.request(`/api/devices/${created.id}`, patch({ name: 'Cuisine' }));
    expect(await json<DeviceStatus>(kept)).toMatchObject({ name: 'Cuisine', hasKey: false });
  });

  it('answers 409 for a duplicate name or host:port and 400 for a bad host or key', async () => {
    const app = setup();
    await app.request('/api/devices', post(input));
    const name = await app.request('/api/devices', post({ ...input, host: '10.0.0.9' }));
    expect(name.status).toBe(409);
    expect((await json<ApiErrorBody>(name)).error.fields).toHaveProperty('name');
    const address = await app.request('/api/devices', post({ ...input, name: 'Bedroom' }));
    expect(address.status).toBe(409);
    expect((await json<ApiErrorBody>(address)).error.fields).toHaveProperty('host');

    const publicHost = await app.request('/api/devices', post({ ...input, name: 'Public', host: '8.8.8.8' }));
    expect(publicHost.status).toBe(400);
    expect((await json<ApiErrorBody>(publicHost)).error.fields).toHaveProperty('host');

    const badKey = await app.request('/api/devices', post({ ...input, name: 'Bad', apiKey: 'not-a-key' }));
    expect(badKey.status).toBe(400);
    expect((await json<ApiErrorBody>(badKey)).error.fields).toHaveProperty('apiKey');
  });

  it('deletes a device and answers 404 afterwards', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    const deleted = await app.request(`/api/devices/${device.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/devices/${device.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await json<DeviceStatus[]>(await app.request('/api/devices'))).toEqual([]);
  });

  it('reconnects an unknown device with 404 and accepts only a reported node name', async () => {
    const app = setup();
    expect((await app.request('/api/devices/999/reconnect', { method: 'POST' })).status).toBe(404);
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    const accept = await app.request(`/api/devices/${device.id}/accept-device`, { method: 'POST' });
    expect(accept.status).toBe(409);
  });

  it('forgets a device conversation (idempotent) and answers 404 for an unknown device', async () => {
    const app = setup();
    expect((await app.request('/api/devices/999/conversation/reset', { method: 'POST' })).status).toBe(404);
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    // A live session: the route drops it (and any pending confirm with it).
    ctx.sessions.get(`device:${device.id}`, 60_000).pendingAction = {
      exposedName: 'send_email',
      argsHash: 'x',
      argumentsJson: '{}',
      createdTurn: 1,
      expiresAt: Date.now() + 60_000,
    };
    const reset = await app.request(`/api/devices/${device.id}/conversation/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    expect(await reset.text()).toBe('');
    expect(ctx.sessions.has(`device:${device.id}`)).toBe(false);
    // Idempotent: a second reset still answers 204.
    expect(
      (await app.request(`/api/devices/${device.id}/conversation/reset`, { method: 'POST' })).status,
    ).toBe(204);
  });

  it('resolves per-Echo overrides, allows only perEcho keys and inherits with null', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));

    const set = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 0, changes: { 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 } }),
    );
    expect(set.status).toBe(200);
    const doc = await json<DeviceSettingsDocument>(set);
    expect(doc.overrides).toEqual({ 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 });
    expect(doc.effective['tts.voice']).toBe('cedar');
    expect(doc.version).toBe(1);

    const rejectedModel = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 1, changes: { 'agent.model': 'gpt-4.1' } }),
    );
    expect(rejectedModel.status).toBe(400);
    expect((await json<ApiErrorBody>(rejectedModel)).error.fields).toHaveProperty('agent.model');

    const unknown = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 1, changes: { 'not.a.key': 1 } }),
    );
    expect(unknown.status).toBe(400);

    const inherit = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 1, changes: { 'tts.voice': null } }),
    );
    const after = await json<DeviceSettingsDocument>(inherit);
    expect(after.overrides).toEqual({ 'vad.endSilenceMs': 600 });
    expect(after.effective['tts.voice']).toBe(ctx.settings.current().settings.tts.voice);
  });

  it('does not store a value equal to the global one', async () => {
    const app = setup();
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    const same = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: ctx.settings.version, changes: { 'tts.voice': 'cedar' } }),
    );
    expect(same.status).toBe(200);
    expect((await json<DeviceSettingsDocument>(same)).overrides).toEqual({});
    expect(ctx.settings.version).toBe(1); // no-op batch does not bump
  });

  it('rejects a stale version with 409', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    const stale = await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 0, changes: { 'tts.speed': 1.3 } }),
    );
    expect(stale.status).toBe(409);
  });

  it('rejects a global change that would break one Echo and names it', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    ctx.settings.applyDevice(device.id, { 'followUp.maxWaitMs': 4000 }, ctx.settings.version);
    const change = await app.request(
      '/api/settings',
      patch({ version: ctx.settings.version, changes: { 'followUp.minWaitMs': 5000 } }),
    );
    expect(change.status).toBe(400);
    const fields = (await json<ApiErrorBody>(change)).error.fields ?? {};
    expect(Object.values(fields).join(' ')).toContain('Kitchen');
    expect(ctx.settings.current().settings.followUp.minWaitMs).toBe(4000);
  });

  it('records device history with its scope and reverts into that device', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(await app.request('/api/devices', post(input)));
    await app.request(
      `/api/devices/${device.id}/settings`,
      patch({ version: 0, changes: { 'tts.speed': 1.5 } }),
    );
    const history = await json<
      { id: number; scope: string; key: string; oldValue: unknown; newValue: unknown }[]
    >(await app.request('/api/settings/changes'));
    expect(history[0]).toMatchObject({
      scope: `device:${device.id}`,
      key: 'tts.speed',
      oldValue: null,
      newValue: 1.5,
    });
    const revert = await app.request(`/api/settings/changes/${history[0]?.id}/revert`, { method: 'POST' });
    expect(revert.status).toBe(200);
    const doc = await json<DeviceSettingsDocument>(await app.request(`/api/devices/${device.id}/settings`));
    expect(doc.overrides).toEqual({});
    expect(doc.effective['tts.speed']).toBe(1);
    expect(ctx.settings.version).toBe(2);
  });

  it('returns the prompt layers this Echo will send', async () => {
    const app = setup();
    const device = await json<DeviceStatus>(
      await app.request('/api/devices', post({ ...input, prompt: 'This Echo is in the kitchen.' })),
    );
    const response = await app.request(`/api/devices/${device.id}/instructions`);
    expect(response.status).toBe(200);
    const doc = await json<InstructionsDocument>(response);
    expect(doc.layers).toHaveLength(3);
    expect(doc.layers[2]).toMatchObject({ layer: 3, text: 'This Echo is in the kitchen.' });
    expect(doc.layers[2]?.title).toContain('Kitchen');
    expect(doc.text).toContain('This Echo is in the kitchen.');
    expect(doc.layers[1]?.title).toBe('Speaker rules, built in');
    expect(doc.text.startsWith('You are a voice assistant')).toBe(true);
  });
});
