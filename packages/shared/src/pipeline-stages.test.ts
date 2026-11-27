import { describe, expect, it } from 'vitest';
import { buildVoicePipelineStages, providerLabel, shortVoiceId } from './pipeline-stages.ts';
import { DEFAULT_SETTINGS } from './settings.registry.ts';

const noKeys = () => false;
const allKeys = () => true;

function values(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFAULT_SETTINGS, ...changes };
}

describe('buildVoicePipelineStages', () => {
  it('summarises the default pipeline without repeating the provider', () => {
    const stages = buildVoicePipelineStages(values(), { hasKey: allKeys });
    expect(stages.map((stage) => stage.id)).toEqual(['listening', 'understanding', 'thinking', 'voice']);
    expect(stages.map((stage) => stage.summary)).toEqual([
      'On-device VAD',
      'gpt-transcribe',
      'gpt-5.4-mini',
      'marin',
    ]);
    expect(stages.map((stage) => stage.eyebrow)).toEqual([
      'Voice activity',
      'Speech-to-text',
      'Agent',
      'Text-to-speech',
    ]);
    expect(stages.map((stage) => stage.provider)).toEqual([null, 'openai', 'openai', 'openai']);
    expect(stages.map((stage) => stage.section)).toEqual(['listening', 'understanding', 'thinking', 'voice']);
    expect(stages.every((stage) => stage.configured)).toBe(true);
  });

  it('follows a mixed draft and shows the ElevenLabs voice name', () => {
    const stages = buildVoicePipelineStages(
      values({
        'stt.provider': 'elevenlabs',
        'stt.elevenlabsModel': 'scribe_v2',
        'tts.provider': 'elevenlabs',
        'tts.elevenlabsVoiceId': 'voice-123',
      }),
      { hasKey: allKeys, voiceNames: { 'voice-123': 'George' } },
    );
    expect(stages.find((stage) => stage.id === 'understanding')).toMatchObject({
      summary: 'scribe_v2',
      provider: 'elevenlabs',
      configured: true,
    });
    expect(stages.find((stage) => stage.id === 'voice')).toMatchObject({
      summary: 'George',
      provider: 'elevenlabs',
    });
  });

  it('falls back to the model and a short pasted voice id, and flags a missing key', () => {
    const stages = buildVoicePipelineStages(
      values({
        'tts.provider': 'elevenlabs',
        'tts.elevenlabsVoiceId': 'AbCdEf1234567890',
        'tts.elevenlabsModel': 'eleven_flash_v2_5',
      }),
      { hasKey: noKeys },
    );
    expect(stages.find((stage) => stage.id === 'voice')).toMatchObject({
      summary: 'eleven_flash_v2_5 · AbCd…',
      configured: false,
    });
    expect(stages.find((stage) => stage.id === 'thinking')?.configured).toBe(false);
    // Listening is on-device and needs no key.
    expect(stages.find((stage) => stage.id === 'listening')?.configured).toBe(true);
  });

  it('names the default premade voice without a voice list', () => {
    const stages = buildVoicePipelineStages(
      values({ 'tts.provider': 'elevenlabs', 'tts.elevenlabsVoiceId': 'JBFqnCBsd6RMkjVDRZzb' }),
      { hasKey: noKeys },
    );
    expect(stages.find((stage) => stage.id === 'voice')?.summary).toBe('George');
  });

  it('labels the providers and shortens ids', () => {
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('elevenlabs')).toBe('ElevenLabs');
    expect(shortVoiceId('JBFqnCBsd6RMkjVDRZzb')).toBe('JBFq…');
    expect(shortVoiceId('short')).toBe('short');
  });
});
