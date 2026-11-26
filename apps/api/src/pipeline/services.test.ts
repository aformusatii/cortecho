import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.ts';
import type { CreateResponse } from './agent.ts';
import {
  type ElevenLabsVoiceProvider,
  missingProviders,
  NotConfiguredError,
  type OpenAiVoice,
  PCM_SAMPLE_RATE,
} from './services.ts';
import { createDispatchServices } from './voice-services.ts';

function settings(changes: Record<string, unknown> = {}): Settings {
  return buildSettings({ ...DEFAULT_SETTINGS, ...changes });
}

function fakeProviders() {
  const make = (name: string) => ({
    transcribe: vi.fn(async () => `${name} transcript`),
    sampleRate: PCM_SAMPLE_RATE,
    synthesize: vi.fn(async function* () {
      yield Buffer.from(name);
    }),
    configured: vi.fn(() => true),
    warmUp: vi.fn(),
  });
  const openai = make('openai') as unknown as OpenAiVoice & { warmUp: ReturnType<typeof vi.fn> };
  openai.createResponse = vi.fn(async () => ({ status: 'completed', output: [] })) as CreateResponse;
  const elevenlabs = make('elevenlabs') as unknown as ElevenLabsVoiceProvider;
  return { openai, elevenlabs };
}

function servicesWith(current: Settings) {
  const providers = fakeProviders();
  const services = createDispatchServices({
    openai: providers.openai,
    elevenlabs: providers.elevenlabs,
    tools: new ToolRegistry(),
    settings: () => current,
  });
  return { services, providers };
}

describe('dispatching voice services', () => {
  it('picks STT and TTS from each turn snapshot, per call', async () => {
    const { services, providers } = servicesWith(
      settings({ 'openai.apiKey': 'k', 'elevenlabs.apiKey': 'e' }),
    );
    const signal = new AbortController().signal;

    await services.stt.transcribe(Buffer.alloc(2), 16_000, signal, settings({ 'stt.provider': 'openai' }));
    await services.stt.transcribe(
      Buffer.alloc(2),
      16_000,
      signal,
      settings({ 'stt.provider': 'elevenlabs' }),
    );
    expect(providers.openai.transcribe).toHaveBeenCalledTimes(1);
    expect(providers.elevenlabs.transcribe).toHaveBeenCalledTimes(1);

    const openaiChunks: Buffer[] = [];
    for await (const chunk of services.tts.synthesize(
      'hello',
      signal,
      settings({ 'tts.provider': 'openai' }),
    )) {
      openaiChunks.push(chunk);
    }
    const elevenLabsChunks: Buffer[] = [];
    for await (const chunk of services.tts.synthesize(
      'hello',
      signal,
      settings({ 'tts.provider': 'elevenlabs' }),
    )) {
      elevenLabsChunks.push(chunk);
    }
    expect(openaiChunks).toEqual([Buffer.from('openai')]);
    expect(elevenLabsChunks).toEqual([Buffer.from('elevenlabs')]);
    expect(services.tts.sampleRate).toBe(24_000);
  });

  it('is configured only when OpenAI (thinking) and every selected provider have keys', () => {
    const both = { 'openai.apiKey': 'k', 'elevenlabs.apiKey': 'e' };
    expect(missingProviders(settings({ ...both, 'stt.provider': 'elevenlabs' }))).toEqual([]);

    const noOpenAi = missingProviders(settings({ 'elevenlabs.apiKey': 'e' }));
    expect(noOpenAi).toEqual(['openai']);

    const elevenLabsStage = missingProviders(
      settings({ 'openai.apiKey': 'k', 'tts.provider': 'elevenlabs' }),
    );
    expect(elevenLabsStage).toEqual(['elevenlabs']);

    // An ElevenLabs key without a selected ElevenLabs stage is not needed.
    expect(missingProviders(settings({ 'openai.apiKey': 'k' }))).toEqual([]);

    const { services } = servicesWith(settings({ 'openai.apiKey': 'k' }));
    expect(services.configured).toBe(true);
    const { services: unconfigured } = servicesWith(settings({ 'tts.provider': 'elevenlabs' }));
    expect(unconfigured.configured).toBe(false);
  });

  it('warm up only the providers the snapshot uses', () => {
    const onlyOpenAi = servicesWith(settings());
    onlyOpenAi.services.warmUp?.(settings());
    expect(onlyOpenAi.providers.openai.warmUp).toHaveBeenCalledTimes(1);
    expect(onlyOpenAi.providers.elevenlabs.warmUp).not.toHaveBeenCalled();

    const mixed = servicesWith(settings({ 'tts.provider': 'elevenlabs' }));
    mixed.services.warmUp?.(settings({ 'tts.provider': 'elevenlabs' }));
    expect(mixed.providers.openai.warmUp).toHaveBeenCalledTimes(1);
    expect(mixed.providers.elevenlabs.warmUp).toHaveBeenCalledTimes(1);
  });

  it('names the missing provider', () => {
    expect(new NotConfiguredError('openai').message).toBe(
      'OpenAI is not configured (no API key in Settings → Providers).',
    );
    expect(new NotConfiguredError('elevenlabs').message).toBe(
      'ElevenLabs is not configured (no API key in Settings → Providers).',
    );
  });
});
