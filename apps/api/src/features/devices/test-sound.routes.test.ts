import type { ApiErrorBody, TestSoundResult } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { createTestRuntime, waitUntil } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime> | null = null;
let echo: FakeEcho | null = null;

afterEach(async () => {
  await ctx?.client?.stop();
  await echo?.stop();
  ctx?.sqlite.close();
  ctx = null;
  echo = null;
});

const json = <T>(response: Response) => response.json() as Promise<T>;

function post() {
  return { method: 'POST' };
}

async function connected() {
  echo = new FakeEcho();
  const port = await echo.start();
  ctx = createTestRuntime({ devices: [{ name: 'Kitchen', port }] });
  echo.fetchAudio = ctx.fetchAudio;
  await ctx.startDevices();
  await waitUntil(() => echo?.isSubscribed === true && ctx?.client.isConnected === true);
  return ctx;
}

describe('POST /api/devices/:id/test-sound', () => {
  it('plays the chime without OpenAI and reports downloaded and finished', async () => {
    const runtime = await connected();
    const id = runtime.created[0]?.id;
    if (id === undefined) throw new Error('expected a device');

    const response = await runtime.app.request(`/api/devices/${id}/test-sound`, post());
    expect(response.status).toBe(200);
    const body = await json<TestSoundResult>(response);
    expect(body).toEqual({
      downloaded: true,
      finished: true,
      url: expect.stringMatching(/\/api\/reply-audio\/[\w-]{22}\.wav$/),
    });
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(echo?.announcements).toEqual([{ mediaId: body.url, text: '', success: true }]);
    expect(echo?.played[0]).toMatchObject({ kind: 'announcement', format: 'wav', sampleRate: 48_000 });
    // No OpenAI call: the wizard can identify an Echo before the OpenAI step.
    expect(runtime.services.calls.tts).toEqual([]);
    expect(runtime.services.calls.stt).toBe(0);
    expect(runtime.services.calls.agent).toEqual([]);
  });

  it('reports downloaded false when the Echo cannot reach the reply address', async () => {
    const runtime = await connected();
    const id = runtime.created[0]?.id;
    if (id === undefined) throw new Error('expected a device');
    runtime.settings.apply({ 'network.replyBaseUrl': 'http://127.0.0.1:9' }, runtime.settings.version);
    if (echo)
      echo.fetchAudio = async () => {
        throw new Error('unreachable');
      };

    const startedAt = Date.now();
    const response = await runtime.app.request(`/api/devices/${id}/test-sound`, post());
    expect(response.status).toBe(200);
    const body = await json<TestSoundResult>(response);
    expect(body).toMatchObject({ downloaded: false, finished: false });
    expect(body.url).toContain('http://127.0.0.1:9/api/reply-audio/');
    // A definitive false report ends the wait instead of sitting out the 8 s cap.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('refuses while the Echo is in a turn, or not connected', async () => {
    const runtime = await connected();
    const id = runtime.created[0]?.id;
    if (id === undefined) throw new Error('expected a device');

    const first = runtime.app.request(`/api/devices/${id}/test-sound`, post());
    const second = await runtime.app.request(`/api/devices/${id}/test-sound`, post());
    expect(second.status).toBe(409);
    expect((await json<ApiErrorBody>(second)).error.code).toBe('ECHO_BUSY');
    expect((await first).status).toBe(200);

    // Unknown device: 404, never a key.
    expect((await runtime.app.request('/api/devices/999/test-sound', post())).status).toBe(404);

    // A device whose link is down cannot play anything.
    await runtime.client.stop();
    await waitUntil(() => !runtime.client.isConnected);
    const down = await runtime.app.request(`/api/devices/${id}/test-sound`, post());
    expect(down.status).toBe(409);
    expect((await json<ApiErrorBody>(down)).error.code).toBe('ECHO_UNAVAILABLE');

    // A disabled row has no runtime to play through.
    const patched = await runtime.app.request(`/api/devices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    const disabled = await runtime.app.request(`/api/devices/${id}/test-sound`, post());
    expect(disabled.status).toBe(409);
    expect((await json<ApiErrorBody>(disabled)).error.code).toBe('ECHO_UNAVAILABLE');
  });
});
