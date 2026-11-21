import { expect, test } from '@playwright/test';
import {
  completeSetup,
  createDevice,
  deleteDevice,
  FAKE_ECHO_PORTS,
  openSettingsSection,
  saveScreenshot,
  settingsVersion,
} from './helpers.ts';

// The e2e server runs without OPENAI_API_KEY (see playwright.config.ts): the
// settings forms still work, and the test phrase reports the missing key.

const IDLE_LABEL = 'Conversation idle time';
const IDLE_FIELD = 'setting-assistant-sessionIdleMinutes';
const SAVE = { name: 'Save', exact: true } as const;

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await openSettingsSection(page, 'assistant');
}

test.describe('Settings page', () => {
  test.beforeEach(async ({ request }) => {
    await completeSetup(request);
  });

  test('edits, validates, saves and resets a value', async ({ page }, testInfo) => {
    await openSettings(page);
    const field = page.getByLabel(IDLE_LABEL, { exact: true });
    const before = await settingsVersion(page);
    await expect(page.getByText('No unsaved changes')).toBeVisible();

    // Validation runs from the descriptor: no request is sent.
    await field.fill('99999');
    await expect(page.getByText('1 unsaved change')).toBeVisible();
    await page.getByRole('button', SAVE).click();
    await expect(page.locator(`#${IDLE_FIELD}-error`)).toContainText('1440');
    expect(await settingsVersion(page)).toBe(before);

    // A valid value saves with the version the form loaded.
    await field.fill('12');
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Settings saved.').first()).toBeVisible();
    await expect.poll(async () => settingsVersion(page)).toBe(before + 1);
    await expect(field).toHaveValue('12');

    // "changed ↺" resets the field to the built-in default (5) and saves it.
    await page.getByRole('button', { name: new RegExp(`Reset ${IDLE_LABEL} to the default`) }).click();
    await page.getByRole('button', SAVE).click();
    await expect.poll(async () => Number(await field.inputValue())).toBe(5);

    await saveScreenshot(page, testInfo, 'settings', { fullPage: false });
  });

  test('lists every combobox option even with a value selected', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await openSettingsSection(page, 'voice');

    // "Voice" already holds a value; the dropdown must still offer the others.
    const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
    await expect(voice).toHaveValue('marin');
    await page.getByRole('button', { name: 'Show all Voice options' }).click();
    const options = page.getByRole('listbox', { name: 'Voice options' }).getByRole('option');
    await expect(options).toHaveCount(12);
    await expect(options.filter({ hasText: 'alloy' })).toBeVisible();
    await expect(options.filter({ hasText: 'verse' })).toBeVisible();

    // The chevron toggles the list without clearing or changing the value.
    await page.getByRole('button', { name: 'Show all Voice options' }).click();
    await expect(page.getByRole('listbox', { name: 'Voice options' })).toBeHidden();
    await expect(voice).toHaveValue('marin');
    await page.getByRole('button', { name: 'Show all Voice options' }).click();

    // Picking one closes the list and writes the chosen value into the input.
    await options.filter({ hasText: 'verse' }).click();
    await expect(voice).toHaveValue('verse');
    await expect(page.getByRole('listbox', { name: 'Voice options' })).toBeHidden();
  });

  test('recovers from a change made in another tab', async ({ page, context }) => {
    await openSettings(page);
    const other = await context.newPage();
    await openSettings(other);

    const otherField = other.getByLabel(IDLE_LABEL, { exact: true });
    await otherField.fill('8');
    await other.getByRole('button', SAVE).click();
    await expect(other.getByText('Settings saved.').first()).toBeVisible();

    // This tab still holds the version it loaded: the save is a 409.
    const field = page.getByLabel(IDLE_LABEL, { exact: true });
    await field.fill('9');
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('These settings changed in another tab')).toBeVisible();
    await page.getByRole('button', { name: 'Reapply my changes' }).click();
    await expect(page.getByText('Settings saved.').first()).toBeVisible();

    // The value survived: reload and read it from the server.
    await page.reload();
    await openSettingsSection(page, 'assistant');
    await expect(page.getByLabel(IDLE_LABEL, { exact: true })).toHaveValue('9');
    await other.close();
  });

  test('shows the history and reverts a change', async ({ page }) => {
    await openSettings(page);
    const field = page.getByLabel(IDLE_LABEL, { exact: true });
    await field.fill('13');
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Settings saved.').first()).toBeVisible();

    await page.getByRole('button', { name: 'History' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Settings history')).toBeVisible();
    await dialog
      .getByRole('button', { name: `Revert ${IDLE_LABEL}` })
      .first()
      .click();
    await expect(page.getByText(`Reverted ${IDLE_LABEL}.`).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();

    // The revert adopted the reverted document into the open form.
    await expect(field).not.toHaveValue('13');
  });

  test('shows the full assembled prompt', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Show the full prompt' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1. Household')).toBeVisible();
    await expect(dialog.getByText('2. Speaker rules')).toBeVisible();
    await expect(dialog.getByText('Joined text (as sent)')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  test('plays a test phrase without saving', async ({ page, request }) => {
    const device = await createDevice(request, {
      name: 'Phrase Echo',
      port: FAKE_ECHO_PORTS.one,
      kind: 'echo',
    });
    try {
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await openSettingsSection(page, 'voice');
      const before = await settingsVersion(page);

      await page.getByRole('button', { name: 'Play', exact: true }).click();
      const results = page.getByRole('list', { name: 'Test phrase results' });
      await expect(results.getByText(/Phrase Echo/)).toBeVisible({ timeout: 15_000 });
      await expect(results.getByText(/OpenAI is not configured/)).toBeVisible();

      // The preview goes through /api/say, which never writes settings.
      expect(await settingsVersion(page)).toBe(before);
    } finally {
      await deleteDevice(request, device.id);
    }
  });
});
