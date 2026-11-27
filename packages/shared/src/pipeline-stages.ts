import type { VoiceProvider } from './settings.registry.ts';

// ---------------------------------------------------------------------------
// The settings page's voice-pipeline navigator, as pure functions: a stage
// summary comes from the current draft values, so it updates while the owner
// edits and stays testable without React.
// ---------------------------------------------------------------------------

export type VoiceStageId = 'listening' | 'understanding' | 'thinking' | 'voice';

export type VoicePipelineStage = {
  id: VoiceStageId;
  /** The short line above the stage title ("Speech-to-text", "Agent", …). */
  eyebrow: string;
  title: string;
  /**
   * What the stage uses, without repeating the provider (the chip names it):
   * a model, a voice name, or "model · short voice id".
   */
  summary: string;
  /** The provider chip target; null for the on-device listening stage. */
  provider: VoiceProvider | null;
  /** The settings section the card scrolls to. */
  section: VoiceStageId;
  /** False when a provider this stage needs has no key. */
  configured: boolean;
};

const PROVIDER_LABELS: Record<VoiceProvider, string> = {
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};

/** Premade voices that exist on every account, so the name is known without a list. */
export const KNOWN_ELEVENLABS_VOICES: Readonly<Record<string, string>> = {
  JBFqnCBsd6RMkjVDRZzb: 'George',
};

export function providerLabel(provider: VoiceProvider): string {
  return PROVIDER_LABELS[provider];
}

/** A provider setting value; anything unexpected means the default (openai). */
export function providerValue(value: unknown): VoiceProvider {
  return value === 'elevenlabs' ? 'elevenlabs' : 'openai';
}

function text(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key];
  return typeof value === 'string' ? value : '';
}

/** "JBFqnCBsd6RMkjVDRZzb" → "JBFq…" (enough to recognise a pasted id). */
export function shortVoiceId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…` : id;
}

export function buildVoicePipelineStages(
  values: Readonly<Record<string, unknown>>,
  {
    hasKey,
    voiceNames = {},
  }: {
    /** Whether the provider's key is available (saved or typed in the draft). */
    hasKey: (key: string) => boolean;
    /** ElevenLabs voice id → name, for the Voice stage's summary. */
    voiceNames?: Readonly<Record<string, string>>;
  },
): VoicePipelineStage[] {
  const sttProvider = providerValue(values['stt.provider']);
  const ttsProvider = providerValue(values['tts.provider']);
  const understandingModel =
    sttProvider === 'elevenlabs' ? text(values, 'stt.elevenlabsModel') : text(values, 'stt.model');
  const elevenLabsVoiceId = text(values, 'tts.elevenlabsVoiceId');
  const elevenLabsVoiceName = voiceNames[elevenLabsVoiceId] ?? KNOWN_ELEVENLABS_VOICES[elevenLabsVoiceId];
  const voice =
    ttsProvider === 'elevenlabs'
      ? (elevenLabsVoiceName ??
        [text(values, 'tts.elevenlabsModel'), shortVoiceId(elevenLabsVoiceId)].filter(Boolean).join(' · '))
      : text(values, 'tts.voice');

  return [
    {
      id: 'listening',
      eyebrow: 'Voice activity',
      title: 'Listening',
      summary: 'On-device VAD',
      provider: null,
      section: 'listening',
      configured: true,
    },
    {
      id: 'understanding',
      eyebrow: 'Speech-to-text',
      title: 'Understanding',
      summary: understandingModel || '—',
      provider: sttProvider,
      section: 'understanding',
      configured: hasKey(`${sttProvider}.apiKey`),
    },
    {
      id: 'thinking',
      eyebrow: 'Agent',
      title: 'Thinking',
      summary: text(values, 'agent.model') || '—',
      provider: 'openai',
      section: 'thinking',
      configured: hasKey('openai.apiKey'),
    },
    {
      id: 'voice',
      eyebrow: 'Text-to-speech',
      title: 'Voice',
      summary: voice || '—',
      provider: ttsProvider,
      section: 'voice',
      configured: hasKey(`${ttsProvider}.apiKey`),
    },
  ];
}
