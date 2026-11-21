import type { ApiErrorBody, SetupDocument } from '@cortecho/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../db/schema.ts';
import { FakeEcho } from '../../esphome/fake-echo.ts';
import { createTestRuntime } from '../../test-support.ts';

const OPENAI_KEY = 'sk-setup-not-a-real-key';

let ctx: ReturnType<typeof createTestRuntime> | null = null;
let echoes: FakeEcho[] = [];

function runtime(options: Parameters<typeof createTestRuntime>[0] = {}) {
  ctx = createTestRuntime(options);
  return ctx;
}

afterEach(async () => {
  await ctx?.runtime.devices.stopAll();
  await Promise.all(echoes.map((echo) => echo.stop()));
  echoes = [];
  ctx?.sqlite.close();
  ctx = null;
});

const json = <T>(response: Response) => response.json() as Promise<T>;
const post = (body?: unknown) => ({
  method: 'POST',
  ...(body === undefined
    ? {}
    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function checkFetch(result: { status?: number; throws?: boolean }) {
  return vi.fn(async () => {
    if (result.throws) throw new TypeError('fetch failed');
    return new Response(null, { status: result.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe('GET /api/setup', () => {
  it('describes a fresh install and never carries a key', async () => {
    const { app } = runtime();
    const response = await app.request('/api/setup');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      onboardingDone: false,
      hasEcho: false,
      hasOpenAiKey: false,
      replyBaseUrl: null,
      homeConfirmed: false,
    });
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain(OPENAI_KEY);
  });

  it('counts only a real Echo, reports the reply address and a stored key', async () => {
    const { app, settings } = runtime({
      devices: [{ name: 'Kitchen', kind: 'test', port: 9 }],
    });
    expect((await json<SetupDocument>(await app.request('/api/setup'))).hasEcho).toBe(false);

    ctx?.repository.create({
      name: 'Hall',
      kind: 'echo',
      host: '127.0.0.1',
      port: 10,
      apiKey: null,
      enabled: false,
      prompt: '',
      mac: null,
    });
    settings.apply(
      { 'network.replyBaseUrl': 'http://192.168.1.10:3000', 'openai.apiKey': OPENAI_KEY },
      settings.version,
    );

    const body = await json<SetupDocument>(await app.request('/api/setup'));
    expect(body).toMatchObject({
      hasEcho: true,
      hasOpenAiKey: true,
      replyBaseUrl: 'http://192.168.1.10:3000',
    });
  });

  it('does not count the time zone the environment import seeded', async () => {
    // cortecho.env.example ships TZ: the import stores it, but that is not a
    // decision the owner made, so a new user must still see "Your home".
    const { app, settings } = runtime({ env: { TZ: 'Europe/Chisinau' } });
    expect(settings.storedValues()['assistant.timeZone']).toBe('Europe/Chisinau');
    expect((await json<SetupDocument>(await app.request('/api/setup'))).homeConfirmed).toBe(false);

    // One owner edit through the API is what counts.
    const saved = await app.request(
      '/api/settings',
      patch({ version: settings.version, changes: { 'assistant.locale': 'en-GB' } }),
    );
    expect(saved.status).toBe(200);
    expect((await json<SetupDocument>(await app.request('/api/setup'))).homeConfirmed).toBe(true);
  });

  it('treats a saved time zone or locale as a confirmed home', async () => {
    const { app, settings } = runtime();
    settings.apply({ 'assistant.timeZone': 'Europe/Chisinau' }, settings.version);
    expect((await json<SetupDocument>(await app.request('/api/setup'))).homeConfirmed).toBe(true);

    const second = runtime();
    second.settings.apply({ 'assistant.locale': 'en-GB' }, second.settings.version);
    expect((await json<SetupDocument>(await second.app.request('/api/setup'))).homeConfirmed).toBe(true);
    second.sqlite.close();
  });
});

describe('POST and DELETE /api/setup/complete', () => {
  it('records completion, answers with the document and is idempotent', async () => {
    const { app, db } = runtime();
    const first = await app.request('/api/setup/complete', post());
    expect(first.status).toBe(200);
    expect((await json<SetupDocument>(first)).onboardingDone).toBe(true);

    const rows = db.select().from(appState).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('onboarding.completedAt');

    // A second completion keeps the first timestamp.
    const second = await app.request('/api/setup/complete', post());
    expect((await json<SetupDocument>(second)).onboardingDone).toBe(true);
    const again = db.select().from(appState).all();
    expect(again[0]?.value).toBe(rows[0]?.value);
  });

  it('forgets the completion on DELETE ("Run the first-time setup again")', async () => {
    const { app } = runtime();
    await app.request('/api/setup/complete', post());
    const response = await app.request('/api/setup/complete', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect((await json<SetupDocument>(response)).onboardingDone).toBe(false);
  });

  it('records the completion when the first Echo is adopted', async () => {
    const echo = new FakeEcho();
    await echo.start();
    echoes.push(echo);
    const { app } = runtime({ linkTimeoutMs: 100 });

    const adopted = await app.request('/api/devices/adopt', post({ host: '127.0.0.1', port: echo.port }));
    expect(adopted.status).toBe(201);
    expect((await json<SetupDocument>(await app.request('/api/setup'))).onboardingDone).toBe(true);
  });
});

describe('POST /api/setup/check-openai', () => {
  it('checks the stored key and answers only ok', async () => {
    const fetchImpl = checkFetch({ status: 200 });
    const { app, settings } = runtime({ fetchImpl });
    settings.apply({ 'openai.apiKey': OPENAI_KEY }, settings.version);

    const response = await app.request('/api/setup/check-openai', post({}));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(body).not.toContain(OPENAI_KEY);
  });

  it('checks a key from the body without storing it', async () => {
    const fetchImpl = checkFetch({ status: 401 });
    const { app, settings } = runtime({ fetchImpl });

    const response = await app.request('/api/setup/check-openai', post({ apiKey: OPENAI_KEY }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, code: 'rejected' });
    expect(body).not.toContain(OPENAI_KEY);
    expect(settings.hasSecret('openai.apiKey')).toBe(false); // never stored
  });

  it('says unreachable when OpenAI cannot be reached', async () => {
    const { app } = runtime({ fetchImpl: checkFetch({ throws: true }) });
    const response = await app.request('/api/setup/check-openai', post({ apiKey: OPENAI_KEY }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: false, code: 'unreachable' });
  });

  it('asks for a key when none is stored or sent, without echoing anything', async () => {
    const fetchImpl = checkFetch({ status: 200 });
    const { app } = runtime({ fetchImpl });
    const response = await app.request('/api/setup/check-openai', post({}));
    expect(response.status).toBe(400);
    const body = await response.text();
    expect((JSON.parse(body) as ApiErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: { apiKey: 'Enter an OpenAI API key first.' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(body).not.toContain(OPENAI_KEY);
  });

  it('uses the configured base URL', async () => {
    const fetchImpl = checkFetch({ status: 200 });
    const { app } = runtime({ env: { OPENAI_BASE_URL: 'http://openai.test/v1' }, fetchImpl });
    await app.request('/api/setup/check-openai', post({ apiKey: OPENAI_KEY }));
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call?.[0]).toBe('http://openai.test/v1/models');
  });
});

describe('settings history', () => {
  it('hasHistory finds a saved key and nothing else', async () => {
    const { app, settings } = runtime();
    expect(settings.hasHistory(['assistant.timeZone'])).toBe(false);
    const saved = await app.request(
      '/api/settings',
      patch({ version: settings.version, changes: { 'assistant.timeZone': 'Europe/Chisinau' } }),
    );
    expect(saved.status).toBe(200);
    expect(settings.hasHistory(['assistant.timeZone'])).toBe(true);
    expect(settings.hasHistory(['assistant.timeZone', 'assistant.locale'])).toBe(true);
    expect(settings.hasHistory(['tts.voice'])).toBe(false);
  });
});
