import { expect, test } from '@playwright/test';
import { cleanSetupState, createDevice, FAKE_ECHO_KEY, FAKE_ECHO_PORTS, waitForStatus } from './helpers.ts';

// Repairs (spec §5.4): device problems carry a Fix that opens the step which
// settles them. The e2e server runs in production mode, so a missing reply
// address is a device problem too.
const WRONG_KEY = Buffer.alloc(32, 3).toString('base64');

test.describe('Repairs', () => {
  test.beforeEach(async ({ request }) => {
    await cleanSetupState(request);
  });
  test.afterEach(async ({ request }) => {
    await cleanSetupState(request);
  });

  test('fixes an Echo whose key Cortecho does not know', async ({ page, request }) => {
    // A keyed FakeEcho and a row without the key: plaintext is refused, so the
    // device reports `encryption-required` (the "already secured" branch).
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.keyed, kind: 'echo' });

    await page.goto('/');
    await waitForStatus(page);
    const card = page.getByRole('region', { name: 'Kitchen' });
    await expect(card.getByText('The Echo has an API key: add the key to this Echo')).toBeVisible({
      timeout: 15_000,
    });

    await card.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'This Echo is already secured.' })).toBeVisible();

    await dialog.getByLabel('Key', { exact: true }).fill(WRONG_KEY);
    await dialog.getByRole('button', { name: 'Use this key' }).click();
    await expect(dialog.getByText("This is not the Echo's key.")).toBeVisible({ timeout: 20_000 });

    await dialog.getByLabel('Key', { exact: true }).fill(FAKE_ECHO_KEY);
    await dialog.getByRole('button', { name: 'Use this key' }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Encrypted (API key)')).toBeVisible();
    const devices = (await (await request.get('/api/devices')).json()) as { hasKey: boolean }[];
    expect(devices[0]).toMatchObject({ hasKey: true });
  });

  test('fixes the reply address from Settings → Network', async ({ page, request }) => {
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one, kind: 'echo' });

    await page.goto('/');
    await waitForStatus(page);
    const card = page.getByRole('region', { name: 'Kitchen' });
    await expect(
      card.getByText("The reply address is not set: add this computer's address in Settings → Network"),
    ).toBeVisible({ timeout: 15_000 });

    await card.getByRole('link', { name: 'Fix' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#section-network');
    // On a phone the section is a collapsed accordion: the anchor opens it.
    await expect(page.getByLabel('Reply address', { exact: true })).toBeVisible();
  });
});
