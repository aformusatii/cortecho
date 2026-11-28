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
import { ECHO_URL } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { setProviders } from '../lib/settings.ts';
import { runStep, type StepFact } from '../lib/steps.ts';
import { parseWav } from '../lib/wav.ts';

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
  test('POST /api/say reaches the Echo as a valid WAV', async ({ page, request }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      // OpenAI is configured in every mode; the announcement is not the place
      // to also prove the ElevenLabs voice (that is the voice turn above).
      await setProviders('openai', 'openai');
      await resetGatewayCalls();

      await runStep(
        testInfo,
        page,
        14,
        'Announcement',
        'announcement',
        async (capture) => {
          const response = await request.post('/api/say', {
            data: { text: 'Integration suite announcement.' },
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
                call.service === 'openai' && call.status === 200 && call.path.includes('/v1/audio/speech'),
            ),
          ).toBe(true);
          await page.goto('/');
          await capture();
        },
        steps,
      );
    } catch (error) {
      failure = error;
    }

    await collectFacts(steps).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
  });
});
