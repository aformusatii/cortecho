import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { describe, expect, it } from 'vitest';
import { buildInstructions, buildPromptLayers, SPEAKER_BRIDGE } from './prompt-layers.ts';

function settings(overrides: Record<string, unknown> = {}): Settings {
  return buildSettings({ ...DEFAULT_SETTINGS, ...overrides });
}

const listenTool = { defaultWaitMs: 8000, minWaitMs: 4000, maxWaitMs: 20000 };

describe('buildPromptLayers', () => {
  it('puts the household prompt first and the speaker rules second', () => {
    const layers = buildPromptLayers({ settings: settings() });
    expect(layers.map((layer) => layer.layer)).toEqual([1, 2]);
    expect(layers[0]?.title).toBe('Household');
    expect(layers[1]?.text).toContain('converted to speech');
  });

  it('adds the per-Echo layer last, with the bridge and a heading, only when it has text', () => {
    const withEcho = buildPromptLayers({
      settings: settings(),
      device: { name: 'Kitchen', prompt: 'This Echo is in the kitchen.' },
    });
    expect(withEcho.map((layer) => layer.layer)).toEqual([1, 2, 3]);
    expect(withEcho[2]).toMatchObject({
      title: 'This Echo ("Kitchen")',
      text: 'This Echo is in the kitchen.',
    });
    expect(withEcho[1]?.text).toContain(SPEAKER_BRIDGE);

    const empty = buildPromptLayers({ settings: settings(), device: { name: 'Kitchen', prompt: '   ' } });
    expect(empty.map((layer) => layer.layer)).toEqual([1, 2]);
    expect(empty[1]?.text).not.toContain(SPEAKER_BRIDGE);
  });

  it('follows the settings: no search policy when web search is off', () => {
    const off = buildPromptLayers({ settings: settings({ 'agent.webSearch': false }) });
    expect(off[1]?.text).toContain('Web search is unavailable');
    expect(off[1]?.text).not.toContain('Answer directly by default');
  });

  it('adds the listen policy only when the follow-up mode is tool', () => {
    const on = buildPromptLayers({ settings: settings(), listenTool });
    expect(on[1]?.text).toContain('listen_for_reply');
    const off = buildPromptLayers({ settings: settings({ 'followUp.mode': 'never' }) });
    expect(off[1]?.text).not.toContain('listen_for_reply');
  });

  it('states the time zone and locale from the settings', () => {
    const layers = buildPromptLayers({
      settings: settings({
        'assistant.timeZone': 'Europe/Berlin',
        'assistant.locale': 'de-DE',
      }),
    });
    expect(layers[1]?.text).toContain('time zone is Europe/Berlin and locale de-DE');
  });

  it('states the default household sentence only once', () => {
    const text = buildInstructions({ settings: settings() });
    expect(text.match(/You are a voice assistant speaking through a small smart speaker/g)).toHaveLength(1);
  });

  it('joins the layers with blank lines, in order', () => {
    const text = buildInstructions({
      settings: settings({ 'assistant.householdPrompt': 'Household.' }),
      device: { name: 'Hall', prompt: 'Hall prompt.' },
    });
    const parts = text.split('\n\n');
    expect(parts[0]).toBe('Household.');
    expect(parts.at(-1)).toBe('Hall prompt.');
    expect(parts[1]).toContain('converted to speech');
  });
});
