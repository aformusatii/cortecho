import { expect, test } from '@playwright/test';
import { deleteDevice, FAKE_ECHO_PORTS, saveScreenshot } from './helpers.ts';

// Add, edit, prompt, tune and delete an Echo against a FakeEcho on localhost.
// Nothing talks to OpenAI (the test phrase is not used here).

test.describe('Echos', () => {
  test('onboards, edits, tunes and deletes an Echo', async ({ page, request }, testInfo) => {
    // A failed earlier run must not break the empty state.
    for (const device of (await (await request.get('/api/devices')).json()) as { id: number }[]) {
      await deleteDevice(request, device.id);
    }

    await page.goto('/echos');
    await expect(page.getByRole('heading', { name: 'No Echos yet' })).toBeVisible();
    await expect(page.getByText('Read “Several Echos” in the README')).toBeVisible();

    await page.getByRole('button', { name: 'Add the first Echo' }).click();
    const add = page.getByRole('dialog');
    await add.getByLabel('Name', { exact: true }).fill('Study');
    await add.getByLabel('Address', { exact: true }).fill('127.0.0.1');
    await add.getByLabel('Port', { exact: true }).fill(String(FAKE_ECHO_PORTS.two));
    await add.getByRole('button', { name: 'Add Echo', exact: true }).click();
    await expect(add).toBeHidden();

    const card = page.getByRole('region', { name: 'Study' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Connected')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('127.0.0.1:26102')).toBeVisible();
    await saveScreenshot(page, testInfo, 'echos');

    try {
      // A duplicate name is reported on the field the API names.
      await page.getByRole('button', { name: 'Add Echo', exact: true }).click();
      const duplicate = page.getByRole('dialog');
      await duplicate.getByLabel('Name', { exact: true }).fill('Study');
      await duplicate.getByLabel('Address', { exact: true }).fill('127.0.0.1');
      await duplicate.getByLabel('Port', { exact: true }).fill(String(FAKE_ECHO_PORTS.one));
      await duplicate.getByRole('button', { name: 'Add Echo', exact: true }).click();
      await expect(duplicate.getByText(/already uses this name/)).toBeVisible();
      await duplicate.getByRole('button', { name: 'Cancel' }).click();

      // The Echo page, on its overview.
      await card.getByRole('link', { name: 'Open Study' }).click();
      await expect(page.getByRole('heading', { name: 'Study', level: 1 })).toBeVisible();
      await expect(page.getByText('e2e-fake-echo-2', { exact: true })).toBeVisible({ timeout: 15_000 });
      if (testInfo.project.name === 'desktop') await saveScreenshot(page, testInfo, 'echo-overview');

      // Connection: rename (a name change does not restart the link).
      await page.getByRole('tab', { name: 'Connection' }).click();
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

      // Delete, with confirmation.
      await page.getByRole('link', { name: 'Open Study Room' }).click();
      await page.getByRole('tab', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Delete this Echo' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page).toHaveURL(/\/echos$/);
      await expect(page.getByRole('heading', { name: 'No Echos yet' })).toBeVisible();
    } finally {
      for (const device of (await (await request.get('/api/devices')).json()) as { id: number }[]) {
        await deleteDevice(request, device.id);
      }
    }
  });
});
