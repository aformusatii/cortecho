import { expect, test } from '@playwright/test';
import {
  type EchoMedia,
  type EchoState,
  echoJson,
  gatewayJson,
  type OpenAiCall,
  resetGatewayCalls,
  waitFor,
} from '../lib/echo.ts';
import { ECHO_URL, ELEVENLABS_ENABLED, ELEVENLABS_MODE } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { setProviders } from '../lib/settings.ts';
import { runStep, type StepFact } from '../lib/steps.ts';
import { parseWav } from '../lib/wav.ts';

const NO_ELEVENLABS = 'ELEVENLABS_API_KEY_E2E is not set for a real run; the ElevenLabs checks are skipped';

async function announcementMedia(): Promise<EchoMedia> {
  const state = await waitFor<EchoState>(
    async () => {
      const current = await echoJson<EchoState>('/state');
      const media = [...current.media].reverse().find((item) => item.kind === 'announcement');
      return media && media.playedBytes !== null ? current : null;
    },
    { what: 'the announcement to play on the Echo', timeoutMs: 60_000 },
  );
  const media = [...state.media].reverse().find((item) => item.kind === 'announcement');
  if (!media) throw new Error('no announcement media after playback');
  return media;
}

test.describe('Announcements', { tag: '@integration' }, () => {
  test.skip(!ELEVENLABS_ENABLED, NO_ELEVENLABS);

  test('POST /api/say reaches the Echo through ElevenLabs as a valid WAV', async ({
    page,
    request,
  }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      await setProviders('openai', 'elevenlabs');
      await resetGatewayCalls();

      await runStep(
        testInfo,
        page,
        24,
        'Announce through ElevenLabs',
        'announce-elevenlabs',
        async (capture) => {
          const response = await request.post('/api/say', {
            data: { text: 'Integration suite announcement through ElevenLabs.' },
          });
          expect(response.status(), await response.text()).toBe(200);
          const media = await announcementMedia();
          const audio = await fetch(`${ECHO_URL}/media/${media.n}`);
          expect(audio.status).toBe(200);
          const info = parseWav(Buffer.from(await audio.arrayBuffer()));
          expect(info.channels).toBe(1);
          expect(info.sampleRate).toBe(24_000);
          expect(info.seconds).toBeGreaterThan(0.5);

          const calls = await gatewayJson<OpenAiCall[]>('/calls');
          expect(
            calls.some(
              (call) =>
                call.service === 'elevenlabs' &&
                call.status === 200 &&
                call.path.includes('/v1/text-to-speech/'),
            ),
          ).toBe(true);
          await page.goto('/');
          await capture();
        },
        steps,
      );
    } catch (error) {
      failure = error;
    } finally {
      // Leave the throwaway stack on the default providers.
      await setProviders('openai', 'openai').catch(() => {});
    }

    await collectFacts(steps).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
    testInfo.annotations.push({ type: 'providers', description: `elevenlabs=${ELEVENLABS_MODE}` });
  });
});
