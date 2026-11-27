import { type APIRequestContext, expect, test } from '@playwright/test';
import { ELEVENLABS_ENABLED, ELEVENLABS_MODE } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { DUMMY_ELEVENLABS_KEY, MISSING_PERMISSIONS_KEY } from '../lib/settings.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

const NO_ELEVENLABS = 'ELEVENLABS_API_KEY_E2E is not set for a real run; the ElevenLabs checks are skipped';

type Settings = { hasKeys: Record<string, boolean> };

async function hasElevenLabsKey(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/settings');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return (JSON.parse(body) as Settings).hasKeys['elevenlabs.apiKey'] === true;
}

/** The Providers tab's ElevenLabs card. */
function card(page: import('@playwright/test').Page) {
  return page.getByTestId('provider-elevenlabs');
}

test.describe('Providers', { tag: '@integration' }, () => {
  test.skip(!ELEVENLABS_ENABLED, NO_ELEVENLABS);

  test('A key is saved, tested, and a scoped key is reported as working', async ({
    page,
    request,
  }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      await runStep(
        testInfo,
        page,
        13,
        'Save the ElevenLabs key',
        'providers-save-key',
        async (capture) => {
          await page.goto('/settings?tab=providers');
          await expect(card(page)).toBeVisible();
          await page.locator('#setting-elevenlabs-apiKey').fill(DUMMY_ELEVENLABS_KEY);
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(page.getByText('Settings saved.', { exact: true }).first()).toBeVisible();
          await expect(card(page).getByText('Key set')).toBeVisible();
          expect(await hasElevenLabsKey(request)).toBe(true);
          // Write-only: the document reports hasKeys, never the value.
          const document = await (await request.get('/api/settings')).json();
          expect(JSON.stringify(document)).not.toContain(DUMMY_ELEVENLABS_KEY);
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        14,
        'Test the key',
        'providers-test-key',
        async (capture) => {
          await card(page).getByRole('button', { name: 'Test key' }).click();
          await expect(page.getByText('Key works.', { exact: true })).toBeVisible();
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        15,
        'A scoped key still works for speech',
        'providers-scoped-key',
        async (capture) => {
          await page.locator('#setting-elevenlabs-apiKey').fill(MISSING_PERMISSIONS_KEY);
          await card(page).getByRole('button', { name: 'Test key' }).click();
          await expect(page.getByText(/Voices → Read \/ Models → Read/)).toBeVisible();
          // The sentinel was never saved: a reload still shows the stored key.
          await page.goto('/settings?tab=providers');
          await expect(card(page).getByText('Key set')).toBeVisible();
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
    testInfo.annotations.push({ type: 'mode', description: `ElevenLabs: ${ELEVENLABS_MODE}` });
  });
});
