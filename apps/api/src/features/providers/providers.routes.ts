import {
  DEFAULT_VOICE_SAMPLE_TEXT,
  providerKeyCheckSchema,
  voiceSampleRequestSchema,
} from '@cortecho/shared';
import { Hono } from 'hono';
import { AppError, validationError } from '../../lib/errors.ts';
import { errorMessage } from '../../lib/logger.ts';
import { validate } from '../../lib/validation.ts';
import { pcmToWav } from '../../pipeline/audio.ts';
import { checkElevenLabsKey } from '../../pipeline/providers/elevenlabs.ts';
import { NotConfiguredError } from '../../pipeline/services.ts';
import { withVoicePreview } from '../../pipeline/voice-pipeline.ts';
import { checkOpenAiKey } from '../setup/openai-check.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { createProvidersService } from './providers.service.ts';

/** How long a voice sample may be cached by the browser. */
const PREVIEW_CACHE = 'public, max-age=3600';

/**
 * The Providers tab's runtime calls: ElevenLabs voices/models (for the
 * pickers), a same-origin voice sample, and the two "Test key" checks.
 * No endpoint here ever returns or logs a key.
 */
export function createProviderRoutes(
  runtime: VoiceRuntime,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
) {
  const providers = createProvidersService({
    settings: runtime.settings,
    baseUrl: runtime.config.elevenlabs.baseUrl,
    fetchImpl,
  });

  const storedKey = (key: 'openai.apiKey' | 'elevenlabs.apiKey'): string =>
    (key === 'openai.apiKey'
      ? runtime.settings.current().settings.openai.apiKey
      : runtime.settings.current().settings.elevenlabs.apiKey) ?? '';

  return (
    new Hono()
      .get('/settings/elevenlabs-voices', async (c) => c.json(await providers.listVoices()))
      .get('/settings/elevenlabs-models', async (c) => c.json(await providers.listModels()))
      // The voice's sample, streamed from ElevenLabs through this app. The URL
      // comes only from the cached voice list for this id, never from the client.
      .get('/settings/elevenlabs-voices/:id/preview', async (c) => {
        const id = c.req.param('id');
        if (id.length === 0 || id.length > 100) throw new AppError(404, 'NOT_FOUND', 'No such voice.');
        const preview = await providers.previewFor(id);
        if (!preview) throw new AppError(404, 'NOT_FOUND', 'No sample for this voice.');
        let upstream: Response;
        try {
          upstream = await fetchImpl(preview, { signal: AbortSignal.timeout(5000) });
        } catch {
          throw new AppError(404, 'NOT_FOUND', 'The voice sample is not available.');
        }
        if (!upstream.ok || !upstream.body) {
          throw new AppError(404, 'NOT_FOUND', 'The voice sample is not available.');
        }
        // Premade samples are mp3s served as text/plain by the public bucket.
        const upstreamType = upstream.headers.get('content-type') ?? '';
        const contentType = /^audio\//i.test(upstreamType) ? upstreamType : 'audio/mpeg';
        return new Response(upstream.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': PREVIEW_CACHE,
          },
        });
      })
      // "Listen here": synthesize the draft voice (both providers) and return a
      // WAV the browser plays. It saves nothing and needs no Echo.
      .post('/settings/voice-sample', validate('json', voiceSampleRequestSchema), async (c) => {
        const { text, ...preview } = c.req.valid('json');
        const settings = withVoicePreview(runtime.settings.current().settings, preview);
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of runtime.services.tts.synthesize(
            text ?? DEFAULT_VOICE_SAMPLE_TEXT,
            c.req.raw.signal,
            settings,
          )) {
            chunks.push(chunk);
          }
        } catch (error) {
          if (error instanceof NotConfiguredError) {
            throw new AppError(503, 'UPSTREAM_ERROR', error.message);
          }
          throw new AppError(502, 'UPSTREAM_ERROR', `The voice sample failed: ${errorMessage(error)}`);
        }
        const wav = pcmToWav(Buffer.concat(chunks), runtime.services.tts.sampleRate);
        return new Response(wav, {
          headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
        });
      })
      .post('/settings/check-openai', validate('json', providerKeyCheckSchema), async (c) => {
        const apiKey = (c.req.valid('json').apiKey?.trim() || storedKey('openai.apiKey')).trim();
        if (apiKey === '') throw validationError({ apiKey: 'Enter an OpenAI API key first.' });
        return c.json(
          await checkOpenAiKey({
            apiKey,
            baseUrl: runtime.config.openai.baseUrl,
            fetchImpl,
          }),
        );
      })
      .post('/settings/check-elevenlabs', validate('json', providerKeyCheckSchema), async (c) => {
        const apiKey = (c.req.valid('json').apiKey?.trim() || storedKey('elevenlabs.apiKey')).trim();
        if (apiKey === '') throw validationError({ apiKey: 'Enter an ElevenLabs API key first.' });
        return c.json(
          await checkElevenLabsKey({
            apiKey,
            baseUrl: runtime.config.elevenlabs.baseUrl,
            fetchImpl,
          }),
        );
      })
  );
}
