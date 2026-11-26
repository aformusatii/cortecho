import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SECRET_SETTING_KEYS,
  SETTING_BY_KEY,
  SETTING_DESCRIPTORS,
} from './settings.registry.ts';

describe('settings registry', () => {
  it('has unique keys', () => {
    const keys = SETTING_DESCRIPTORS.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SETTING_BY_KEY.size).toBe(keys.length);
  });

  it('has a default for every key that passes its own schema', () => {
    for (const descriptor of SETTING_DESCRIPTORS) {
      expect(DEFAULT_SETTINGS).toHaveProperty(descriptor.key);
      const parsed = descriptor.schema.safeParse(DEFAULT_SETTINGS[descriptor.key]);
      expect(
        parsed.success,
        `${descriptor.key}: ${parsed.success ? '' : parsed.error.issues[0]?.message}`,
      ).toBe(true);
    }
  });

  it('gives every number and slider bounds that agree with its schema', () => {
    const numeric = SETTING_DESCRIPTORS.filter(
      (descriptor) => descriptor.control === 'number' || descriptor.control === 'slider',
    );
    expect(numeric.length).toBeGreaterThan(0);
    for (const descriptor of numeric) {
      const where = descriptor.key;
      expect(descriptor.min, `${where}: min`).toBeTypeOf('number');
      expect(descriptor.max, `${where}: max`).toBeTypeOf('number');
      expect(descriptor.step, `${where}: step`).toBeGreaterThan(0);
      const { min, max, step } = descriptor;
      expect(min, `${where}: min < max`).toBeLessThan(max as number);

      // The default is inside the bounds and the bounds themselves are valid.
      const value = DEFAULT_SETTINGS[descriptor.key];
      expect(typeof value, `${where}: numeric default`).toBe('number');
      expect(value as number).toBeGreaterThanOrEqual(min as number);
      expect(value as number).toBeLessThanOrEqual(max as number);
      expect(descriptor.schema.safeParse(min).success, `${where}: min passes`).toBe(true);
      expect(descriptor.schema.safeParse(max).success, `${where}: max passes`).toBe(true);

      // One step outside either bound is rejected: the form can never produce
      // a value the API refuses.
      expect(
        descriptor.schema.safeParse((min as number) - (step as number)).success,
        `${where}: below min`,
      ).toBe(false);
      expect(
        descriptor.schema.safeParse((max as number) + (step as number)).success,
        `${where}: above max`,
      ).toBe(false);
    }
  });

  it('keeps every text maxLength in step with its schema', () => {
    const limited = SETTING_DESCRIPTORS.filter((descriptor) => descriptor.maxLength !== undefined);
    expect(limited.map((descriptor) => descriptor.key)).toEqual(
      expect.arrayContaining(['assistant.householdPrompt', 'stt.prompt', 'tts.instructions']),
    );
    for (const descriptor of limited) {
      const limit = descriptor.maxLength as number;
      expect(descriptor.schema.safeParse('x'.repeat(limit)).success, `${descriptor.key}: at the limit`).toBe(
        true,
      );
      expect(
        descriptor.schema.safeParse('x'.repeat(limit + 1)).success,
        `${descriptor.key}: over the limit`,
      ).toBe(false);
    }
  });

  it('marks the provider keys as secrets', () => {
    expect(SECRET_SETTING_KEYS).toEqual(['openai.apiKey', 'elevenlabs.apiKey']);
    expect(SETTING_BY_KEY.get('openai.apiKey')?.secret).toBe(true);
    expect(SETTING_BY_KEY.get('elevenlabs.apiKey')?.secret).toBe(true);
    // The ElevenLabs key is new: it has no environment import.
    expect(SETTING_BY_KEY.get('elevenlabs.apiKey')?.env).toBeUndefined();
  });

  it('points every conditional field at a select option', () => {
    const conditional = SETTING_DESCRIPTORS.filter((descriptor) => descriptor.showWhen !== undefined);
    expect(conditional.map((descriptor) => descriptor.key)).toEqual(
      expect.arrayContaining([
        'stt.model',
        'stt.elevenlabsModel',
        'tts.model',
        'tts.voice',
        'tts.elevenlabsVoiceId',
      ]),
    );
    for (const descriptor of conditional) {
      const showWhen = descriptor.showWhen;
      if (!showWhen) throw new Error(`${descriptor.key}: missing showWhen`);
      const target = SETTING_BY_KEY.get(showWhen.key);
      expect(target, `${descriptor.key}: ${showWhen.key} exists`).toBeDefined();
      expect(target?.control, `${descriptor.key}: ${showWhen.key} is a select`).toBe('select');
      expect(target?.options, `${descriptor.key}: ${showWhen.key} offers ${showWhen.equals}`).toContain(
        showWhen.equals,
      );
    }
  });

  it('labels select options with values that exist', () => {
    const labelled = SETTING_DESCRIPTORS.filter((descriptor) => descriptor.optionLabels !== undefined);
    expect(labelled.map((descriptor) => descriptor.key)).toEqual(
      expect.arrayContaining(['stt.provider', 'tts.provider']),
    );
    for (const descriptor of labelled) {
      expect(descriptor.control).toBe('select');
      for (const value of Object.keys(descriptor.optionLabels ?? {})) {
        expect(descriptor.options, `${descriptor.key}: ${value}`).toContain(value);
      }
    }
  });

  it('defaults both audio stages to OpenAI and keeps thinking there', () => {
    expect(DEFAULT_SETTINGS['stt.provider']).toBe('openai');
    expect(DEFAULT_SETTINGS['tts.provider']).toBe('openai');
    expect(SETTING_BY_KEY.get('agent.model')?.section).toBe('thinking');
  });

  it('allows per-Echo overrides only for room-dependent knobs', () => {
    const perEcho = SETTING_DESCRIPTORS.filter((descriptor) => descriptor.perEcho).map((d) => d.key);
    expect(perEcho).toEqual(
      expect.arrayContaining([
        'tts.voice',
        'tts.speed',
        'stt.languages',
        'vad.endSilenceMs',
        'followUp.mode',
        'reply.prebufferMs',
      ]),
    );
    expect(perEcho).not.toContain('agent.model');
    expect(perEcho).not.toContain('openai.apiKey');
    expect(perEcho).not.toContain('network.replyBaseUrl');
  });
});

describe('network.replyBaseUrl', () => {
  const schema = SETTING_BY_KEY.get('network.replyBaseUrl')?.schema;
  if (!schema) throw new Error('network.replyBaseUrl must exist');

  it('is the Network section, global, with the upgrade-copy env name', () => {
    expect(SETTING_BY_KEY.get('network.replyBaseUrl')).toMatchObject({
      section: 'network',
      perEcho: false,
      default: '',
      env: 'REPLY_AUDIO_BASE_URL',
    });
  });

  it('accepts empty, LAN URLs and host names, stripping trailing slashes', () => {
    expect(schema.safeParse('')).toMatchObject({ success: true, data: '' });
    expect(schema.safeParse('http://192.168.1.10:3000')).toMatchObject({
      success: true,
      data: 'http://192.168.1.10:3000',
    });
    const slashed = schema.safeParse('http://192.168.1.10:3000///');
    if (slashed.success) expect(slashed.data).toBe('http://192.168.1.10:3000');
    const named = schema.safeParse('  http://cortecho.local:3000  ');
    if (named.success) expect(named.data).toBe('http://cortecho.local:3000');
    expect(schema.safeParse('https://10.0.0.2:8443').success).toBe(true);
  });

  it('refuses public addresses and anything with a path, query or fragment', () => {
    for (const value of [
      'ftp://192.168.1.10',
      'http://8.8.8.8:3000',
      'http://192.168.1.10:3000/api',
      'http://192.168.1.10:3000?x=1',
      'http://192.168.1.10:3000#y',
      'not an address',
    ]) {
      expect(schema.safeParse(value).success, value).toBe(false);
    }
    const publicAddress = schema.safeParse('http://8.8.8.8:3000');
    if (!publicAddress.success) {
      expect(publicAddress.error.issues[0]?.message).toContain("this computer's address");
    }
  });
});
