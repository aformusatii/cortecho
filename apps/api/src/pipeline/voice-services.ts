import type { Settings, VoiceProvider } from '@cortecho/shared';
import type { Config } from '../config.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { ResponsesAgent } from './agent.ts';
import { createElevenLabsProvider } from './providers/elevenlabs.ts';
import { createOpenAiProvider } from './providers/openai.ts';
import {
  type ElevenLabsVoiceProvider,
  missingProviders,
  type OpenAiVoice,
  PCM_SAMPLE_RATE,
  type ProviderVoice,
  type VoiceServices,
} from './services.ts';

// ---------------------------------------------------------------------------
// The factory lives here, not in services.ts: providers/* import the shared
// types and constants from services.ts, so services.ts must stay a leaf.
// ---------------------------------------------------------------------------

/** The dispatching services, testable with fake providers. */
export function createDispatchServices({
  openai,
  elevenlabs,
  tools,
  settings,
}: {
  openai: OpenAiVoice;
  elevenlabs: ElevenLabsVoiceProvider;
  tools: ToolRegistry;
  settings: () => Settings;
}): VoiceServices {
  const providerFor = (provider: VoiceProvider): ProviderVoice =>
    provider === 'elevenlabs' ? elevenlabs : openai;

  return {
    stt: {
      transcribe: (pcm, sampleRate, signal, current) =>
        providerFor(current.stt.provider).transcribe(pcm, sampleRate, signal, current),
    },
    tts: {
      sampleRate: PCM_SAMPLE_RATE,
      synthesize: (text, signal, current) =>
        providerFor(current.tts.provider).synthesize(text, signal, current),
    },
    agent: new ResponsesAgent({ createResponse: openai.createResponse, tools }),
    get configured() {
      return missingProviders(settings()).length === 0;
    },
    warmUp: (current) => {
      // The agent always uses OpenAI; ElevenLabs is warmed only when a stage does.
      openai.warmUp(current);
      if (current.stt.provider === 'elevenlabs' || current.tts.provider === 'elevenlabs') {
        elevenlabs.warmUp(current);
      }
    },
  };
}

/** The production services: OpenAI + ElevenLabs, dispatched from the turn snapshot. */
export function createVoiceServices(
  config: Pick<Config, 'openai'>,
  tools: ToolRegistry,
  settings: () => Settings,
): VoiceServices {
  return createDispatchServices({
    openai: createOpenAiProvider(config),
    elevenlabs: createElevenLabsProvider(),
    tools,
    settings,
  });
}
