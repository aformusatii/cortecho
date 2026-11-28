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

function servicesWith() {
  const providers = fakeProviders();
  const services = createDispatchServices({
    openai: providers.openai,
    elevenlabs: providers.elevenlabs,
    tools: new ToolRegistry(),
  });
  return { services, providers };
}

describe('dispatching voice services', () => {
  it('picks STT and TTS from each turn snapshot, per call', async () => {
    const { services, providers } = servicesWith();
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

  it('routes a mixed snapshot stage by stage (OpenAI STT + ElevenLabs TTS and back)', async () => {
    const { services, providers } = servicesWith();
    const signal = new AbortController().signal;

    // One snapshot selects one provider per audio stage, independently.
    const openAiListen = settings({ 'stt.provider': 'openai', 'tts.provider': 'elevenlabs' });
    await services.stt.transcribe(Buffer.alloc(2), 16_000, signal, openAiListen);
    for await (const _chunk of services.tts.synthesize('hello', signal, openAiListen)) {
      // drain
    }
    expect(providers.openai.transcribe).toHaveBeenCalledTimes(1);
    expect(providers.elevenlabs.transcribe).not.toHaveBeenCalled();
    expect(providers.elevenlabs.synthesize).toHaveBeenCalledTimes(1);
    expect(providers.openai.synthesize).not.toHaveBeenCalled();

    const elevenLabsListen = settings({ 'stt.provider': 'elevenlabs', 'tts.provider': 'openai' });
    await services.stt.transcribe(Buffer.alloc(2), 16_000, signal, elevenLabsListen);
    for await (const _chunk of services.tts.synthesize('hello', signal, elevenLabsListen)) {
      // drain
    }
    expect(providers.elevenlabs.transcribe).toHaveBeenCalledTimes(1);
    expect(providers.openai.transcribe).toHaveBeenCalledTimes(1);
    expect(providers.openai.synthesize).toHaveBeenCalledTimes(1);
    expect(providers.elevenlabs.synthesize).toHaveBeenCalledTimes(1);
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

    // Readiness takes the snapshot: two Echos of one process can differ.
    const { services } = servicesWith();
    expect(services.isConfigured(settings({ 'openai.apiKey': 'k' }))).toBe(true);
    expect(services.isConfigured(settings({ 'tts.provider': 'elevenlabs' }))).toBe(false);
    expect(services.isConfigured(settings({ 'openai.apiKey': 'k', 'elevenlabs.apiKey': 'e' }))).toBe(true);
  });

  it('warm up only the providers the snapshot uses', () => {
    const onlyOpenAi = servicesWith();
    onlyOpenAi.services.warmUp?.(settings());
    expect(onlyOpenAi.providers.openai.warmUp).toHaveBeenCalledTimes(1);
    expect(onlyOpenAi.providers.elevenlabs.warmUp).not.toHaveBeenCalled();

    const mixed = servicesWith();
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
