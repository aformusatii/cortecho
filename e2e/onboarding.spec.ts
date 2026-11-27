import { expect, test } from '@playwright/test';
import {
  cleanSetupState,
  completeSetup,
  createDevice,
  FAKE_ECHO_PORTS,
  readSetup,
  restartSetup,
  saveScreenshot,
} from './helpers.ts';

// The first launch (spec §11 e2e 1): `/` redirects to the onboarding, the four
// steps run in order, and the status page then shows the Echo connected and
// secured. The OpenAI check is stubbed at the browser: e2e never reaches the
// internet. `restartSetup` puts the fresh install back for every viewport.
const FAKE_OPENAI_KEY = 'sk-e2e-not-a-real-key';

test.describe('Onboarding', () => {
  test.beforeEach(async ({ request }) => {
    await cleanSetupState(request);
    await restartSetup(request);
  });
  test.afterEach(async ({ request }) => {
    await cleanSetupState(request);
  });

  test('first launch: redirect, home, OpenAI, add an Echo, status', async ({ page, request }, testInfo) => {
    await page.route('**/api/setup/check-openai', (route) => route.fulfill({ json: { ok: true } }));
    const setup = await readSetup(request);
    expect(setup).toMatchObject({ onboardingDone: false, hasEcho: false });

    // `/` → `/setup` (spec §8.3). The redirect is the first visit of this tab.
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);

    await expect(page.getByRole('heading', { name: 'Welcome to Cortecho' })).toBeVisible();
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();

    if (!setup.homeConfirmed) {
      await expect(page.getByRole('heading', { name: 'Your home' })).toBeVisible();
      await expect(page.getByText('Step 2 of 4')).toBeVisible();
      await page.getByLabel('Time zone', { exact: true }).fill('Europe/Berlin');
      await page.getByLabel('Locale', { exact: true }).selectOption('en-GB');
      await page.getByRole('button', { name: 'Next' }).click();
      await expect.poll(async () => (await readSetup(request)).homeConfirmed).toBe(true);
    } else {
      // The settings history is append-only, so on the later viewports the Home
      // step is the documented skip: Welcome goes straight to Step 3.
      await expect(page.getByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
      await expect(page.getByText('Step 3 of 4')).toBeVisible();
    }

    await page.getByLabel('API key', { exact: true }).fill(FAKE_OPENAI_KEY);
    await page.getByRole('button', { name: 'Check and continue' }).click();

    // Step 4: the Add Echo flow, embedded.
    await expect(page.getByRole('heading', { name: 'Add your Echo' })).toBeVisible();
    await page.getByRole('radio', { name: /Echo Dot 2 000001/ }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Add Echo Dot 2 000001?' })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByRole('button', { name: 'Kitchen' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: /^Say:/ })).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();

    // The flow's own finish, then the onboarding's Ready screen.
    await expect(page.getByRole('heading', { name: 'Kitchen is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Cortecho is ready' })).toBeVisible();
    await expect(page.getByText('to Kitchen any time')).toBeVisible();
    await saveScreenshot(page, testInfo, 'setup-onboarding', { fullPage: false });

    await page.getByRole('button', { name: 'Go to Status' }).click();
    await expect(page).toHaveURL(/\/$/);
    const card = page.getByRole('region', { name: 'Kitchen' });
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Encrypted (API key)')).toBeVisible();

    const devices = (await (await request.get('/api/devices')).json()) as {
      kind: string;
      hasKey: boolean;
      encryption: string;
    }[];
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ kind: 'echo', hasKey: true, encryption: 'noise' });
    expect((await readSetup(request)).onboardingDone).toBe(true);
  });

  test('Skip for now reaches the status banner and comes back', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);

    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
    await expect(page.getByText('Cortecho is not set up yet.')).toBeVisible();

    await page.getByRole('link', { name: 'Continue setup' }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Welcome to Cortecho' })).toBeVisible();
  });

  test('an install with an Echo never sees the onboarding', async ({ page, request }) => {
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one, kind: 'echo' });
    await completeSetup(request);
    const setup = await readSetup(request);
    expect(setup).toMatchObject({ onboardingDone: true, hasEcho: true });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
    await expect(page.getByText('Cortecho is not set up yet.')).toBeHidden();

    // `/setup` after onboarding is the Add Echo flow, with the re-run link.
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'Choose your Echo' })).toBeVisible();
    await page.getByRole('button', { name: 'Run the first-time setup again' }).click();

    // An explicit re-run skips nothing, even when the history has the answers.
    await expect(page.getByRole('heading', { name: 'Welcome to Cortecho' })).toBeVisible();
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(page.getByRole('heading', { name: 'Your home' })).toBeVisible();
  });
});
