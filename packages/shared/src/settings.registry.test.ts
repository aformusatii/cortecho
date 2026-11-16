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

  it('marks the OpenAI key as the secret', () => {
    expect(SECRET_SETTING_KEYS).toEqual(['openai.apiKey']);
    expect(SETTING_BY_KEY.get('openai.apiKey')?.secret).toBe(true);
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
  });
});
