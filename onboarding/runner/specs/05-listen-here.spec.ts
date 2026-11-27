import { expect, type Page, test } from '@playwright/test';
import { ELEVENLABS_ENABLED, ELEVENLABS_MODE } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

const NO_ELEVENLABS = 'ELEVENLABS_API_KEY_E2E is not set for a real run; the ElevenLabs checks are skipped';

type PlayRecord = { blob: boolean; playing: boolean; ended: boolean; time: number };

/** What an audio element needs here (the runner's tsconfig has no DOM lib). */
type PlayableElement = {
  src: string;
  currentTime: number;
  addEventListener: (type: string, listener: () => void) => void;
};

type PlayWindow = {
  __voicePlays?: PlayRecord[];
  HTMLMediaElement: { prototype: PlayableElement & { play: () => Promise<void> } };
};

/** Opens one settings section (they are <details> elements). */
async function openSection(page: Page, section: string): Promise<void> {
  const details = page.locator(`#section-${section}`);
  if ((await details.evaluate((element) => element.tagName)) !== 'DETAILS') return;
  if (await details.evaluate((element) => (element as { open?: boolean }).open === true)) return;
  await details.locator('summary').first().click();
}

/**
 * Records every HTMLMediaElement.play() with whether it was the real clip (a
 * blob URL) and how far it got. The player's Audio element is not in the DOM.
 */
async function recordPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as PlayWindow;
    const plays: PlayRecord[] = [];
    scope.__voicePlays = plays;
    const proto = scope.HTMLMediaElement.prototype;
    const original = proto.play;
    proto.play = function play(this: PlayableElement) {
      const record: PlayRecord = {
        blob: this.src.startsWith('blob:'),
        playing: false,
        ended: false,
        time: 0,
      };
      plays.push(record);
      this.addEventListener('playing', () => {
        record.playing = true;
      });
      this.addEventListener('timeupdate', () => {
        record.time = this.currentTime;
      });
      this.addEventListener('ended', () => {
        record.ended = true;
      });
      return original.call(this);
    };
  });
}

async function listenAndWait(page: Page, provider: 'openai' | 'elevenlabs'): Promise<void> {
  await page.evaluate(() => {
    ((globalThis as unknown as { __voicePlays?: PlayRecord[] }).__voicePlays ?? []).length = 0;
  });
  await page.getByLabel('Text-to-speech provider', { exact: true }).selectOption(provider);
  // The sample button sits on the selected voice field (and on the test phrase).
  const button = page.getByRole('button', { name: 'Listen to this voice' }).first();
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          ((globalThis as unknown as { __voicePlays?: PlayRecord[] }).__voicePlays ?? []).some(
            (play) => play.blob && play.playing && (play.time > 0 || play.ended),
          ),
        ),
      { timeout: 45_000, message: `the ${provider} sample actually played` },
    )
    .toBe(true);
}

test.describe('Listen here', { tag: '@integration' }, () => {
  test.skip(!ELEVENLABS_ENABLED, NO_ELEVENLABS);

  test('plays a real sample in this browser, for both providers', async ({ page }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    // The Chromium project runs this first; WebKit (iPhone) gets its own numbers.
    const base = testInfo.project.name === 'webkit' ? 22 : 20;
    try {
      await recordPlayback(page);
      await page.goto('/settings');
      await openSection(page, 'voice');

      await runStep(
        testInfo,
        page,
        base,
        'Listen here (ElevenLabs)',
        `${testInfo.project.name}-listen-elevenlabs`,
        async (capture) => {
          await listenAndWait(page, 'elevenlabs');
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        base + 1,
        'Listen here (OpenAI)',
        `${testInfo.project.name}-listen-openai`,
        async (capture) => {
          // Reload discards the unsaved provider draft; select explicitly again.
          await page.goto('/settings');
          await openSection(page, 'voice');
          await listenAndWait(page, 'openai');
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
    testInfo.annotations.push({
      type: 'browser',
      description: `${testInfo.project.name}, ElevenLabs: ${ELEVENLABS_MODE}`,
    });
  });
});
