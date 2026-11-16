import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import OpenAI, { toFile } from 'openai';
import type { Config } from '../config.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { type CreateResponse, ResponsesAgent } from './agent.ts';
import { pcmToWav } from './audio.ts';
import { NotConfiguredError, type SpeechToText, type TextToSpeech, type VoiceServices } from './services.ts';

/** OpenAI's `pcm` speech format: 24 kHz, 16-bit signed LE, mono. */
export const OPENAI_PCM_RATE = 24_000;

/**
 * Builds the OpenAI-backed services. The key is a setting now, so the client
 * is created on first use and replaced when the key changes; the timeout is
 * passed per request because it is a setting too. The key is only handed to
 * the SDK: it is never logged or stored anywhere else.
 */
export function createOpenAiServices(
  config: Pick<Config, 'openai'>,
  tools: ToolRegistry,
  settings: () => Settings = () => buildSettings(DEFAULT_SETTINGS),
): VoiceServices {
  const baseURL = config.openai.baseUrl;
  let cached: { key: string; client: OpenAI } | null = null;

  const clientFor = (current: Settings): OpenAI => {
    const key = current.openai.apiKey;
    if (!key) throw new NotConfiguredError();
    if (!cached || cached.key !== key) {
      cached = { key, client: new OpenAI({ apiKey: key, baseURL, maxRetries: 1 }) };
    }
    return cached.client;
  };

  /** The SDK's per-request options: the abort signal and the settings' timeout. */
  const requestOptions = (current: Settings, signal: AbortSignal) => ({
    signal,
    timeout: current.openai.timeoutMs,
  });

  const speechToText: SpeechToText = {
    async transcribe(pcm, sampleRate, signal, current) {
      const file = await toFile(pcmToWav(pcm, sampleRate), 'utterance.wav', { type: 'audio/wav' });
      // gpt-transcribe takes a list of `languages`; older models take one `language`.
      const languageHint =
        current.stt.languages.length === 0
          ? {}
          : current.stt.model.startsWith('gpt-transcribe')
            ? { languages: current.stt.languages }
            : { language: current.stt.languages[0] };
      const result = await clientFor(current).audio.transcriptions.create(
        {
          model: current.stt.model,
          file,
          response_format: 'json',
          ...(current.stt.prompt ? { prompt: current.stt.prompt } : {}),
          ...languageHint,
        },
        requestOptions(current, signal),
      );
      return result.text.trim();
    },
  };

  const createResponse: CreateResponse = async (request, signal, onTextDelta, current) => {
    // Streamed, so the pipeline can start speaking the first sentence while
    // the rest is still being written. The request is built from our own
    // loosely typed items (see agent.ts).
    const stream = await clientFor(current).responses.create(
      { ...request, stream: true } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      requestOptions(current, signal),
    );
    let result: Awaited<ReturnType<CreateResponse>> | null = null;
    let searching = false;
    const started = new Map<string, number>();
    const searchDurations: Record<string, number> = {};
    for await (const event of stream) {
      if (event.type === 'response.output_item.added' && event.item.type === 'web_search_call') {
        searching = true;
        started.set(event.item.id, performance.now());
      }
      if (event.type === 'response.output_item.done' && event.item.type === 'web_search_call') {
        const start = started.get(event.item.id);
        if (start !== undefined) searchDurations[event.item.id] = Math.round(performance.now() - start);
      }
      if (event.type === 'response.output_text.delta') {
        if (!searching) onTextDelta?.(event.delta);
      } else if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete' ||
        event.type === 'response.failed'
      ) {
        // The agent checks the status; a streamed response has no `output_text`,
        // the agent then reads the text from `output`.
        result = event.response as unknown as Awaited<ReturnType<CreateResponse>>;
      } else if (event.type === 'error') {
        throw new Error(`OpenAI stream error: ${event.message}`);
      }
    }
    if (!result) throw new Error('The response stream ended without a result');
    return { ...result, searchDurations };
  };

  /**
   * A cold connection to OpenAI costs about 200 ms (measured), and an idle
   * one is closed after 15 to 30 s. The SDK uses the same global fetch, so
   * this request leaves an open connection for the turn's first real one.
   * It carries no key; the 401 it gets is all it needs.
   */
  const warmUp = (): void => {
    if (!settings().openai.apiKey) return;
    fetch(`${baseURL ?? 'https://api.openai.com/v1'}/models`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  };

  const textToSpeech: TextToSpeech = {
    sampleRate: OPENAI_PCM_RATE,
    async *synthesize(text, signal, current) {
      const response = await clientFor(current).audio.speech.create(
        {
          model: current.tts.model,
          voice: current.tts.voice,
          input: text,
          response_format: 'pcm',
          speed: current.tts.speed,
          // `instructions` is not supported by tts-1 / tts-1-hd.
          ...(current.tts.model.startsWith('tts-1') ? {} : { instructions: current.tts.instructions }),
        },
        requestOptions(current, signal),
      );
      if (!response.body) throw new Error('TTS response has no body');
      // The body streams while OpenAI is still generating, so playback can
      // start after the first chunk instead of after the whole answer.
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        yield Buffer.from(chunk);
      }
    },
  };

  return {
    stt: speechToText,
    agent: new ResponsesAgent({ createResponse, tools }),
    tts: textToSpeech,
    get configured() {
      return Boolean(settings().openai.apiKey);
    },
    warmUp,
  };
}
