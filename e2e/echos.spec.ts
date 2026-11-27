import { expect, test } from '@playwright/test';
import { cleanSetupState, createDevice, FAKE_ECHO_PORTS, saveScreenshot } from './helpers.ts';

// The Echos page with the setup flow: one Echo is added from its Discovered
// card (name, identify, Done), then a second flow proves the name rules; the
// rest of the page (connection, prompt, tuning, delete) runs on a device that
// the API created, so it does not depend on the wizard.

test.describe('Echos', () => {
  test.beforeEach(async ({ request }) => {
    await cleanSetupState(request);
  });
  test.afterEach(async ({ request }) => {
    await cleanSetupState(request);
  });

  test('adds an Echo from its Discovered card and keeps the name unique', async ({
    page,
    request,
  }, testInfo) => {
    await page.goto('/echos');
    const card = page.getByRole('region', { name: 'Echo Dot 2 000002' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Add' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add Echo Dot 2 000002?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Study');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await expect(dialog.getByRole('heading', { name: 'Study is ready' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    const study = page.getByRole('region', { name: 'Study' });
    await expect(study).toBeVisible();
    await expect(study.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(study.getByText('127.0.0.1:26102')).toBeVisible();
    await saveScreenshot(page, testInfo, 'echos');

    // A second Echo cannot take the same name: the name field reports it.
    await page.getByRole('link', { name: 'Setup' }).click();
    await expect(page.getByRole('heading', { name: 'Choose your Echo' })).toBeVisible();
    await page.getByRole('radio', { name: /Echo Dot 2 000001/ }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Study');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Another Echo already uses this name.')).toBeVisible();
    expect((await (await request.get('/api/devices')).json()) as { name: string }[]).toHaveLength(2);
  });

  test('connects, edits, tunes and deletes an Echo', async ({ page, request }, testInfo) => {
    await createDevice(request, { name: 'Study', port: FAKE_ECHO_PORTS.two, kind: 'test' });

    await page.goto('/echos');
    const card = page.getByRole('region', { name: 'Study' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('127.0.0.1:26102')).toBeVisible();

    // The Echo page, on its overview.
    await card.getByRole('link', { name: 'Open Study' }).click();
    await expect(page.getByRole('heading', { name: 'Study', level: 1 })).toBeVisible();
    await expect(page.getByText('e2e-fake-echo-2', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Not secured', { exact: true }).first()).toBeVisible();
    // Forget conversation: present, but disabled until the Echo has a live session.
    const forget = page.getByRole('button', { name: 'Forget conversation' });
    await expect(forget).toBeVisible();
    await expect(forget).toBeDisabled();
    if (testInfo.project.name === 'desktop') await saveScreenshot(page, testInfo, 'echo-overview');

    // Connection: the key lives under Advanced; rename without restarting.
    await page.getByRole('tab', { name: 'Connection' }).click();
    await expect(page.getByLabel('Key', { exact: true })).toBeHidden();
    await page.getByText('Advanced', { exact: true }).click();
    await expect(page.getByLabel('Key', { exact: true })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Study Room');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(page.getByText('Saved.', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Study Room', level: 1 })).toBeVisible();

    // Prompt: save it and see it in the assembled prompt.
    await page.getByRole('tab', { name: 'Prompt' }).click();
    await page
      .getByRole('textbox', { name: 'Prompt for this Echo' })
      .fill('This Echo is in the study. “The light” means the desk lamp.');
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await expect(page.getByText(/Prompt saved/)).toBeVisible();
    await page.getByRole('button', { name: 'Show the full prompt' }).click();
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText(/This Echo \("Study Room"\)/)).toBeVisible();
    await expect(prompt.getByText(/the desk lamp/).first()).toBeVisible();
    await prompt.getByRole('button', { name: 'Close' }).click();

    // Tuning: override the voice speed, save, then inherit it again.
    await page.getByRole('tab', { name: 'Tuning' }).click();
    const speedOverride = page.getByRole('switch', { name: 'Override Speed' });
    await expect(speedOverride).not.toBeChecked();
    await speedOverride.click();
    await expect(page.getByLabel('Speed', { exact: true })).toBeEnabled();
    await page.getByLabel('Speed', { exact: true }).fill('1.2');
    await page.getByRole('button', { name: 'Save for this Echo' }).click();
    await expect(page.getByText(/settings saved/).first()).toBeVisible();

    await page.getByRole('link', { name: 'All Echos' }).click();
    await expect(page.getByRole('region', { name: 'Study Room' }).getByText('1 override')).toBeVisible();

    await page.getByRole('link', { name: 'Open Study Room' }).click();
    await page.getByRole('tab', { name: 'Tuning' }).click();
    await page.getByRole('switch', { name: 'Override Speed' }).click();
    await page.getByRole('button', { name: 'Save for this Echo' }).click();
    await expect(page.getByText(/settings saved/).first()).toBeVisible();

    await page.getByRole('link', { name: 'All Echos' }).click();
    await expect(page.getByRole('region', { name: 'Study Room' }).getByText('0 overrides')).toBeVisible();

    // Tuning: this Echo can use its own voice provider, and inherit it again.
    await page.getByRole('link', { name: 'Open Study Room' }).click();
    await page.getByRole('tab', { name: 'Tuning' }).click();
    const providerOverride = page.getByRole('switch', { name: 'Override Text-to-speech provider' });
    await expect(providerOverride).not.toBeChecked();
    await providerOverride.click();
    await page.getByLabel('Text-to-speech provider', { exact: true }).selectOption('elevenlabs');
    // Inherited fields render as "Inherits the global value", not as controls.
    await expect(page.getByText('ElevenLabs voice', { exact: true })).toBeVisible();
    await expect(page.getByText('ElevenLabs stability', { exact: true })).toBeVisible();
    await expect(page.locator('#setting-tts-model')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save for this Echo' }).click();
    await expect(page.getByText(/settings saved/).first()).toBeVisible();

    await page.getByRole('link', { name: 'All Echos' }).click();
    await expect(page.getByRole('region', { name: 'Study Room' }).getByText('1 override')).toBeVisible();

    await page.getByRole('link', { name: 'Open Study Room' }).click();
    await page.getByRole('tab', { name: 'Tuning' }).click();
    await page.getByRole('switch', { name: 'Override Text-to-speech provider' }).click();
    await page.getByRole('button', { name: 'Save for this Echo' }).click();
    await expect(page.getByText(/settings saved/).first()).toBeVisible();

    await page.getByRole('link', { name: 'All Echos' }).click();
    await expect(page.getByRole('region', { name: 'Study Room' }).getByText('0 overrides')).toBeVisible();

    // Delete, with confirmation: the warning names the key.
    await page.getByRole('link', { name: 'Open Study Room' }).click();
    await page.getByRole('tab', { name: 'Delete' }).click();
    await expect(page.getByText(/stays secured with this key/)).toBeVisible();
    await page.getByRole('button', { name: 'Delete this Echo' }).click();
    await expect(page.getByRole('alertdialog').getByText(/stays secured with this key/)).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(/\/echos$/);
    await expect(page.getByRole('heading', { name: 'Echos', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Study Room' })).toBeHidden();
  });
});
