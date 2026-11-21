import type { DeviceSettingsDocument, DeviceStatus, SayResponse } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho, syntheticSpeech } from '../../esphome/fake-echo.ts';
import { listenToolOptions } from '../../pipeline/listen-tool.ts';
import { buildInstructions } from '../../pipeline/prompt-layers.ts';
import { createTestRuntime, type TestDevice, waitUntil } from '../../test-support.ts';

// Two fake hassmics, one gateway: real TCP, framing, Noise and HTTP; only the
// OpenAI services are fakes. This is the multi-Echo contract (spec §7, §13).

let echoes: FakeEcho[] = [];
let ctx: ReturnType<typeof createTestRuntime>;

type Spec = {
  name: string;
  /** The node name the fake Echo reports. */
  nodeName?: string;
  /** A node name already learned by the gateway (to test the unexpected-device guard). */
  knownNodeName?: string;
  /** A MAC already learned by the gateway (to test the unexpected-device guard). */
  knownMac?: string;
  prompt?: string;
  overrides?: Record<string, unknown>;
  enabled?: boolean;
};

async function setup(
  specs: Spec[] = [
    { name: 'Kitchen', nodeName: 'kitchen' },
    { name: 'Bedroom', nodeName: 'bedroom' },
  ],
) {
  echoes = await Promise.all(
    specs.map(async (spec, index) => {
      // Each fake Echo is a distinct device: the MAC is the identity now.
      const echo = new FakeEcho({
        nodeName: spec.nodeName ?? spec.name.toLowerCase(),
        macAddress: fakeMac(index + 1),
      });
      await echo.start();
      return echo;
    }),
  );
  const devices: TestDevice[] = specs.map((spec, index) => ({
    name: spec.name,
    host: '127.0.0.1',
    port: echoes[index]?.port ?? 1,
    prompt: spec.prompt,
    overrides: spec.overrides,
    enabled: spec.enabled,
    nodeName: spec.knownNodeName,
    mac: spec.knownMac,
  }));
  ctx = createTestRuntime({ devices });
  for (const echo of echoes) echo.fetchAudio = ctx.fetchAudio;
  await ctx.startDevices();
  return ctx;
}

/** "02000000000N": one MAC (12 hex, the stored form) per fake Echo in a test. */
function fakeMac(index: number): string {
  return `0200000000${index.toString(16).padStart(2, '0')}`;
}

async function bothConnected() {
  await waitUntil(() =>
    echoes.every((echo, index) => ctx.created[index]?.enabled === false || echo.isSubscribed),
  );
}

afterEach(async () => {
  await ctx?.runtime.devices.stopAll();
  await Promise.all(echoes.map((echo) => echo.stop()));
  echoes = [];
  ctx?.sqlite.close();
});

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

function deviceId(name: string): number {
  const device = ctx.created.find((candidate) => candidate.name === name);
  if (!device) throw new Error(`no device ${name}`);
  return device.id;
}

describe('two Echos', () => {
  it('each get a turn, recorded with their device and settings version', async () => {
    await setup();
    await bothConnected();
    ctx.settings.apply({ 'tts.voice': 'cedar' }, 0);
    const [kitchen, bedroom] = echoes;

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);
    await bedroom?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);

    const turns = ctx.turns.latest(5);
    expect(turns.map((turn) => turn.deviceName).sort()).toEqual(['Bedroom', 'Kitchen']);
    expect(turns.every((turn) => turn.outcome === 'answered')).toBe(true);
    expect(turns.every((turn) => turn.settingsVersion === 1)).toBe(true);
    expect(turns.every((turn) => turn.deviceId !== null)).toBe(true);
  });

  it('keeps memory separate per Echo, and separate from /api/ask without a device', async () => {
    await setup();
    await bothConnected();
    let call = 0;
    ctx.services.sttResult = async () => {
      call += 1;
      return call === 1 ? 'what is in the kitchen' : 'what is in the bedroom';
    };
    const [kitchen, bedroom] = echoes;

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);
    expect(ctx.services.calls.agentHistory[0]).toEqual([]);

    await bedroom?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    expect(ctx.services.calls.agentHistory[1]).toEqual([]);

    const asked = await ctx.app.request('/api/ask', post({ text: 'a web question' }));
    expect(asked.status).toBe(200);
    expect(ctx.services.calls.agentHistory[2]).toEqual([]);

    // The next turn on the kitchen sees only the kitchen's own history.
    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 4);
    const history = ctx.services.calls.agentHistory[3] as { content?: string }[];
    expect(history.map((item) => item.content)).toEqual(['what is in the kitchen']);
  });

  it('sends each Echo its own layer 3 and its own effective settings', async () => {
    await setup([
      { name: 'Kitchen', nodeName: 'kitchen' },
      {
        name: 'Bedroom',
        nodeName: 'bedroom',
        prompt: 'This Echo is in the bedroom.',
        overrides: { 'tts.voice': 'cedar' },
      },
    ]);
    await bothConnected();
    const [kitchen, bedroom] = echoes;

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);
    await bedroom?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);

    expect(ctx.services.calls.agentDevices).toEqual([
      { name: 'Kitchen', prompt: '' },
      { name: 'Bedroom', prompt: 'This Echo is in the bedroom.' },
    ]);
    expect(ctx.services.calls.ttsSettings[0]?.tts.voice).toBe(ctx.settings.current().settings.tts.voice);
    expect(ctx.services.calls.ttsSettings[1]?.tts.voice).toBe('cedar');
  });

  it('applies a setting change from the next turn, not mid-turn', async () => {
    await setup();
    await bothConnected();
    let release: () => void = () => {};
    let call = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.services.agentResult = async () => {
      call += 1;
      if (call === 1) await gate;
      return { text: 'It is noon.', toolCalls: [] };
    };
    const kitchen = echoes[0];
    const ids = deviceId('Kitchen');

    const turn = kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.services.calls.agent.length === 1);
    ctx.settings.applyDevice(ids, { 'tts.speed': 1.5 }, ctx.settings.version);
    release();
    await turn;
    await waitUntil(() => ctx.turns.latest(5).length === 1);
    expect(ctx.services.calls.ttsSettings[0]?.tts.speed).toBe(1);

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    expect(ctx.services.calls.ttsSettings[1]?.tts.speed).toBe(1.5);
  });

  it('keeps the memory when the prompt is edited', async () => {
    await setup();
    await bothConnected();
    const kitchen = echoes[0];
    const ids = deviceId('Kitchen');

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);

    const edited = await ctx.app.request(
      `/api/devices/${ids}`,
      patch({ prompt: 'The kitchen Echo is next to the oven.' }),
    );
    expect(edited.status).toBe(200);

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    expect(ctx.services.calls.agentDevices[1]?.prompt).toBe('The kitchen Echo is next to the oven.');
    const history = ctx.services.calls.agentHistory[1] as { content?: string }[];
    expect(history.map((item) => item.content)).toEqual(['what time is it']);
  });

  it('exposes exactly the instructions the next request sends', async () => {
    await setup([
      { name: 'Kitchen', nodeName: 'kitchen', prompt: 'This Echo is in the kitchen.' },
      { name: 'Bedroom', nodeName: 'bedroom' },
    ]);
    await bothConnected();
    await echoes[0]?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);

    const ids = deviceId('Kitchen');
    const document = await json<{ text: string }>(await ctx.app.request(`/api/devices/${ids}/instructions`));
    const sentSettings = ctx.services.calls.agentSettings[0];
    const sentDevice = ctx.services.calls.agentDevices[0];
    expect(sentSettings).toBeDefined();
    const expected = buildInstructions({
      settings: sentSettings as NonNullable<typeof sentSettings>,
      listenTool: listenToolOptions(sentSettings as NonNullable<typeof sentSettings>),
      device: sentDevice,
    });
    expect(document.text).toBe(expected);
  });

  it('plays the replies of two turn-taking Echos', async () => {
    await setup();
    await bothConnected();
    const [kitchen, bedroom] = echoes;
    await Promise.all([kitchen?.runPipeline(syntheticSpeech()), bedroom?.runPipeline(syntheticSpeech())]);
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    expect(kitchen?.played).toHaveLength(1);
    expect(bedroom?.played).toHaveLength(1);
    expect(ctx.turns.latest(5).every((turn) => turn.outcome === 'answered')).toBe(true);
  });

  it('says on all enabled Echoes, or on one; a failure is reported, not thrown', async () => {
    await setup([
      { name: 'Kitchen', nodeName: 'kitchen' },
      { name: 'Bedroom', nodeName: 'bedroom' },
      { name: 'Off', nodeName: 'off', enabled: false },
    ]);
    await bothConnected();
    const [kitchen, bedroom, off] = echoes;

    const all = await ctx.app.request('/api/say', post({ text: 'Dinner is ready.' }));
    expect(all.status).toBe(200);
    const results = (await json<SayResponse>(all)).results;
    expect(results.map((result) => result.deviceName)).toEqual(['Kitchen', 'Bedroom']);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(kitchen?.announcements).toHaveLength(1);
    expect(bedroom?.announcements).toHaveLength(1);
    expect(off?.announcements).toHaveLength(0);

    const one = await ctx.app.request(
      '/api/say',
      post({ text: 'Only here.', deviceId: deviceId('Bedroom') }),
    );
    expect((await json<SayResponse>(one)).results).toHaveLength(1);
    expect(bedroom?.announcements).toHaveLength(2);
    expect(kitchen?.announcements).toHaveLength(1);

    // A device that is explicitly asked but disabled reports its failure.
    const disabled = await ctx.app.request('/api/say', post({ text: 'x', deviceId: deviceId('Off') }));
    expect(disabled.status).toBe(200);
    expect((await json<SayResponse>(disabled)).results[0]).toMatchObject({
      ok: false,
      error: { code: 'ECHO_UNAVAILABLE' },
    });
  });

  it('adds, disables, edits and deletes an Echo at runtime', async () => {
    await setup([{ name: 'Kitchen', nodeName: 'kitchen' }]);
    await bothConnected();
    const bedroom = new FakeEcho({ nodeName: 'bedroom', macAddress: fakeMac(2) });
    await bedroom.start();
    bedroom.fetchAudio = ctx.fetchAudio;
    echoes.push(bedroom);

    const created = await json<DeviceStatus>(
      await ctx.app.request('/api/devices', post({ name: 'Bedroom', host: '127.0.0.1', port: bedroom.port })),
    );
    await waitUntil(() => bedroom.isSubscribed);
    const row = ctx.devices.device(created.id);
    expect(row).not.toBeNull();
    expect(ctx.devices.status(row as NonNullable<typeof row>).state).toBe('connected');

    const disabled = await ctx.app.request(`/api/devices/${created.id}`, patch({ enabled: false }));
    expect(await json<DeviceStatus>(disabled)).toMatchObject({ enabled: false, state: 'disabled' });
    await waitUntil(() => !bedroom.isSubscribed);

    await ctx.app.request(`/api/devices/${created.id}`, patch({ enabled: true }));
    await waitUntil(() => bedroom.isSubscribed);

    // A prompt edit does not replace the link.
    const client = ctx.devices.runtime(created.id)?.client;
    const renamed = await json<DeviceStatus>(
      await ctx.app.request(`/api/devices/${created.id}`, patch({ name: 'Guest', prompt: 'Spare room.' })),
    );
    expect(renamed.name).toBe('Guest');
    expect(bedroom.isSubscribed).toBe(true);
    expect(ctx.devices.runtime(created.id)?.client).toBe(client);

    // Moving it to another address replaces the runtime (old link closed).
    // The same Echo at a new address: same MAC, or the guard would see another device.
    const other = new FakeEcho({ nodeName: 'bedroom', macAddress: fakeMac(2) });
    await other.start();
    other.fetchAudio = ctx.fetchAudio;
    echoes.push(other);
    await ctx.app.request(`/api/devices/${created.id}`, patch({ port: other.port }));
    await waitUntil(() => other.isSubscribed);
    expect(bedroom.isSubscribed).toBe(false);

    const deleted = await ctx.app.request(`/api/devices/${created.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    await waitUntil(() => !other.isSubscribed);
    expect(ctx.devices.runtime(created.id)).toBeNull();
  });

  it('reports a duplicate node name on both Echos', async () => {
    await setup([
      { name: 'Kitchen', nodeName: 'twin' },
      { name: 'Bedroom', nodeName: 'twin' },
    ]);
    await bothConnected();
    await waitUntil(
      () => ctx.devices.list().every((device) => device.problem === 'duplicate-node-name'),
      5000,
    );
    const statuses = await json<DeviceStatus[]>(await ctx.app.request('/api/devices'));
    expect(statuses.map((device) => device.problem)).toEqual(['duplicate-node-name', 'duplicate-node-name']);
  });

  it('closes the link for an unexpected device and accepts the new node name', async () => {
    await setup([{ name: 'Kitchen', nodeName: 'kitchen', knownNodeName: 'was-at-this-address' }]);
    await bothConnected();
    const kitchen = echoes[0];
    await waitUntil(() => ctx.devices.list()[0]?.problem === 'unexpected-device');
    await waitUntil(() => !(kitchen?.isSubscribed ?? true));

    const ids = deviceId('Kitchen');
    const accepted = await ctx.app.request(`/api/devices/${ids}/accept-device`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    expect(await json<DeviceStatus>(accepted)).toMatchObject({
      nodeName: 'kitchen',
      problem: null,
    });
    await waitUntil(() => kitchen?.isSubscribed ?? false);
  });

  it('learns the node name at the first connect', async () => {
    await setup([{ name: 'Kitchen' }]);
    await bothConnected();
    await waitUntil(() => ctx.devices.list()[0]?.nodeName === 'kitchen');
  });

  it('learns the MAC at the first connect and shows it in the status', async () => {
    await setup([{ name: 'Kitchen' }]);
    await bothConnected();
    await waitUntil(() => ctx.devices.list()[0]?.mac === fakeMac(1));
    const statuses = await json<DeviceStatus[]>(await ctx.app.request('/api/devices'));
    expect(statuses[0]?.mac).toBe(fakeMac(1));
  });

  it('treats a different MAC as an unexpected device and adopts it on accept', async () => {
    await setup([{ name: 'Kitchen', nodeName: 'kitchen', knownMac: '0200000000ff' }]);
    await waitUntil(() => ctx.devices.list()[0]?.problem === 'unexpected-device');
    await waitUntil(() => !(echoes[0]?.isSubscribed ?? true));

    const accepted = await ctx.app.request(`/api/devices/${deviceId('Kitchen')}/accept-device`, {
      method: 'POST',
    });
    expect(accepted.status).toBe(200);
    expect(await json<DeviceStatus>(accepted)).toMatchObject({
      mac: fakeMac(1),
      problem: null,
    });
    await waitUntil(() => echoes[0]?.isSubscribed ?? false);
  });
});

describe('/api/ask and /api/say with a device', () => {
  it('runs the device prompt, memory and overrides; unknown ids are 404', async () => {
    await setup([
      { name: 'Kitchen', nodeName: 'kitchen', prompt: 'Kitchen prompt.', overrides: { 'tts.voice': 'nova' } },
      { name: 'Bedroom', nodeName: 'bedroom' },
    ]);
    await bothConnected();
    const ids = deviceId('Kitchen');

    const asked = await ctx.app.request('/api/ask', post({ text: 'kitchen question', deviceId: ids }));
    expect(asked.status).toBe(200);
    expect(ctx.services.calls.agentDevices.at(-1)).toEqual({ name: 'Kitchen', prompt: 'Kitchen prompt.' });
    expect(ctx.services.calls.agentSettings.at(-1)?.tts.voice).toBe('nova');
    const turn = (await json<{ turn: { deviceId: number; deviceName: string } }>(asked)).turn;
    expect(turn).toMatchObject({ deviceId: ids, deviceName: 'Kitchen' });

    // The same Echo's voice turn sees that conversation (same session key).
    await echoes[0]?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    const history = ctx.services.calls.agentHistory.at(-1) as { content?: string }[];
    expect(history.map((item) => item.content)).toEqual(['kitchen question']);

    expect((await ctx.app.request('/api/ask', post({ text: 'x', deviceId: 999 }))).status).toBe(404);
    expect((await ctx.app.request('/api/say', post({ text: 'x', deviceId: 999 }))).status).toBe(404);
  });
});

describe('per-Echo settings via the API', () => {
  it('applies an override for one Echo only and inherits it again', async () => {
    await setup();
    await bothConnected();
    const [kitchen, bedroom] = echoes;
    const kitchenId = deviceId('Kitchen');

    const response = await ctx.app.request(
      `/api/devices/${kitchenId}/settings`,
      patch({ version: ctx.settings.version, changes: { 'tts.voice': 'nova' } }),
    );
    expect(response.status).toBe(200);
    expect(await json<DeviceSettingsDocument>(response)).toMatchObject({
      overrides: { 'tts.voice': 'nova' },
    });

    await kitchen?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 1);
    await bedroom?.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2);
    expect(ctx.services.calls.ttsSettings[0]?.tts.voice).toBe('nova');
    expect(ctx.services.calls.ttsSettings[1]?.tts.voice).toBe(ctx.settings.current().settings.tts.voice);
  });
});
