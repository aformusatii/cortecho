import { type SetupDocument, setupCheckOpenAiSchema } from '@cortecho/shared';
import { Hono } from 'hono';
import { validationError } from '../../lib/errors.ts';
import { validate } from '../../lib/validation.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { checkOpenAiKey } from './openai-check.ts';

/** The settings whose history proves the owner already set up the Home step. */
const HOME_KEYS = ['assistant.timeZone', 'assistant.locale'] as const;

/** What the `/` redirect, the status banner and the onboarding's skip logic read (spec §7.6). */
export function buildSetupDocument(runtime: VoiceRuntime): SetupDocument {
  const replyBaseUrl = runtime.settings.current().settings.network.replyBaseUrl.trim();
  return {
    onboardingDone: runtime.setup.onboardingCompletedAt() !== null,
    // A test device does not count: only a real Echo ends the first launch.
    hasEcho: runtime.devices.list().some((device) => device.kind === 'echo'),
    hasOpenAiKey: runtime.settings.hasSecret('openai.apiKey'),
    replyBaseUrl: replyBaseUrl === '' ? null : replyBaseUrl,
    homeConfirmed: runtime.settings.hasHistory(HOME_KEYS),
  };
}

export type SetupRouteOptions = {
  /** Tests inject a fake; production uses the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * The setup wizard's state and its OpenAI check. Nothing here ever answers
 * with the OpenAI key: only `hasOpenAiKey`.
 */
export function createSetupRoutes(runtime: VoiceRuntime, options: SetupRouteOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return (
    new Hono()
      .get('/setup', (c) => c.json(buildSetupDocument(runtime)))

      .post('/setup/complete', (c) => {
        runtime.setup.completeOnboarding();
        return c.json(buildSetupDocument(runtime));
      })

      // "Run the first-time setup again" (spec §4). Safe for an install with an
      // Echo: the `/` redirect also requires that no `echo` device exists.
      .delete('/setup/complete', (c) => {
        runtime.setup.restartOnboarding();
        return c.json(buildSetupDocument(runtime));
      })

      .post('/setup/check-openai', validate('json', setupCheckOpenAiSchema), async (c) => {
        const body = c.req.valid('json');
        // A key in the body is checked without being stored (the step saves it
        // first); otherwise the stored key is checked for the "skip" decision.
        const apiKey = (
          body.apiKey?.trim() ||
          runtime.settings.current().settings.openai.apiKey ||
          ''
        ).trim();
        if (apiKey === '') {
          throw validationError({ apiKey: 'Enter an OpenAI API key first.' });
        }
        return c.json(
          await checkOpenAiKey({
            apiKey,
            baseUrl: runtime.config.openai.baseUrl,
            fetchImpl,
          }),
        );
      })
  );
}
