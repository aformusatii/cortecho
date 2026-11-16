import type { Health, InstructionsDocument, SettingsChange, SettingsDocument } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { createTestRuntime } from '../../test-support.ts';

let ctx: ReturnType<typeof createTestRuntime>;

function setup(env: Record<string, string> = {}) {
  ctx = createTestRuntime({ env });
  return createApp({ db: ctx.db, voice: ctx.runtime });
}

afterEach(() => ctx.sqlite.close());

const json = <T>(response: Response) => response.json() as Promise<T>;

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('GET /api/settings', () => {
  it('returns the defaults, the version and no secret values', async () => {
    const app = setup();
    const response = await app.request('/api/settings');
    expect(response.status).toBe(200);
    const body = await json<SettingsDocument>(response);
    expect(body.version).toBe(0);
    expect(body.stored).toEqual({});
    expect(body.effective['tts.voice']).toBe('marin');
    expect(body.effective).not.toHaveProperty('openai.apiKey');
    expect(body.hasKeys).toEqual({ 'openai.apiKey': false });
  });

  it('imports the environment once and reports it as version 1', async () => {
    const app = setup({ TTS_VOICE: 'cedar', VAD_END_SILENCE_MS: '600' });
    const body = await json<SettingsDocument>(await app.request('/api/settings'));
    expect(body.version).toBe(1);
    expect(body.stored).toEqual({ 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 });
    expect(body.effective['tts.voice']).toBe('cedar');
    const health = await json<Health>(await app.request('/api/health'));
    expect(health.settingsVersion).toBe(1);
  });
});

describe('PATCH /api/settings', () => {
  it('saves a batch, bumps the version once and reaches the next turn', async () => {
    const app = setup();
    const response = await app.request(
      '/api/settings',
      patch({ version: 0, changes: { 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 } }),
    );
    expect(response.status).toBe(200);
    const body = await json<SettingsDocument>(response);
    expect(body.version).toBe(1);
    expect(body.stored).toEqual({ 'tts.voice': 'cedar', 'vad.endSilenceMs': 600 });
    expect(body.effective['tts.voice']).toBe('cedar');

    const health = await json<Health>(await app.request('/api/health'));
    expect(health.settingsVersion).toBe(1);

    const turn = await app.request('/api/ask', post({ text: 'hi' }));
    expect(turn.status).toBe(200);
  });

  it('returns 409 when the form carries an old version', async () => {
    const app = setup();
    await app.request('/api/settings', patch({ version: 0, changes: { 'tts.voice': 'cedar' } }));
    const stale = await app.request('/api/settings', patch({ version: 0, changes: { 'tts.voice': 'nova' } }));
    expect(stale.status).toBe(409);
    expect(await json<{ error: { code: string } }>(stale)).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('returns 400 with the field that failed, and keeps the version', async () => {
    const app = setup();
    const response = await app.request(
      '/api/settings',
      patch({ version: 0, changes: { 'vad.endSilenceMs': 5 } }),
    );
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string; fields: Record<string, string> } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toHaveProperty('vad.endSilenceMs');
    expect((await json<SettingsDocument>(await app.request('/api/settings'))).version).toBe(0);
  });

  it('rejects a change that breaks a cross-field rule', async () => {
    const app = setup();
    const response = await app.request(
      '/api/settings',
      patch({ version: 0, changes: { 'followUp.minWaitMs': 9000, 'followUp.maxWaitMs': 5000 } }),
    );
    expect(response.status).toBe(400);
  });

  it('writes history and reverts a change as a new one', async () => {
    const app = setup();
    await app.request('/api/settings', patch({ version: 0, changes: { 'tts.voice': 'cedar' } }));
    const history = await json<SettingsChange[]>(await app.request('/api/settings/changes?limit=10'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ key: 'tts.voice', oldValue: null, newValue: 'cedar' });

    const change = history[0];
    if (!change) throw new Error('expected a history row');
    const revert = await app.request(`/api/settings/changes/${change.id}/revert`, { method: 'POST' });
    expect(revert.status).toBe(200);
    const body = await json<SettingsDocument>(revert);
    expect(body.version).toBe(2);
    expect(body.effective['tts.voice']).toBe('marin');
  });
});

describe('secrets', () => {
  it('stores the OpenAI key write-only and keeps it out of the history', async () => {
    const app = setup();
    const saved = await app.request(
      '/api/settings',
      patch({ version: 0, changes: { 'openai.apiKey': 'sk-secret-value' } }),
    );
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('sk-secret-value');
    const body = JSON.parse(text) as SettingsDocument;
    expect(body.hasKeys).toEqual({ 'openai.apiKey': true });
    expect(body.effective).not.toHaveProperty('openai.apiKey');

    const history = await json<SettingsChange[]>(await app.request('/api/settings/changes'));
    expect(history[0]).toMatchObject({ key: 'openai.apiKey', oldValue: null, newValue: null });
    expect(JSON.stringify(history)).not.toContain('sk-secret-value');
  });
});

describe('GET /api/settings/instructions', () => {
  it('returns the layers the next request sends, following the settings', async () => {
    const app = setup();
    await app.request(
      '/api/settings',
      patch({
        version: 0,
        changes: {
          'assistant.householdPrompt': 'You live in Berlin.',
          'agent.webSearch': false,
        },
      }),
    );
    const response = await app.request('/api/settings/instructions');
    expect(response.status).toBe(200);
    const body = await json<InstructionsDocument>(response);
    expect(body.layers.map((layer) => layer.layer)).toEqual([1, 2]);
    expect(body.layers[0]?.text).toBe('You live in Berlin.');
    expect(body.layers[1]?.text).toContain('Web search is unavailable');
    expect(body.text).toBe(body.layers.map((layer) => layer.text).join('\n\n'));
  });
});
