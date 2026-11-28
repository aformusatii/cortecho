import { expect, test } from '@playwright/test';
import {
  cleanSetupState,
  createDevice,
  FAKE_ECHO_KEY,
  FAKE_ECHO_PORTS,
  isMobile,
  openSettingsSection,
  patchSetting,
  readSettings,
  saveScreenshot,
} from './helpers.ts';

// The setup wizard against the FakeEcho pool (e2e/fake-echo-server.ts):
// discovery, the Add Echo flow in both shells, ignore, a keyed Echo, the reply
// address screen, and an Echo added by address when nothing was found.

const WRONG_KEY = Buffer.alloc(32, 3).toString('base64');
const DISCOVERED_TWO = 'Echo Dot 2 000002';

test.describe('Setup', () => {
  test.beforeEach(async ({ request }) => {
    await cleanSetupState(request);
  });
  test.afterEach(async ({ request }) => {
    await cleanSetupState(request);
  });

  test('shows Setup on every page and opens the flow', async ({ page }, testInfo) => {
    for (const path of ['/', '/echos', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'Setup' })).toBeVisible();
    }

    await page.goto('/');
    await page.getByRole('link', { name: 'Setup' }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Setup', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose your Echo' })).toBeVisible();
    // No horizontal scrolling at any of the three viewports.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (testInfo.project.name === 'desktop') await saveScreenshot(page, testInfo, 'setup');
  });

  test('discovers a second Echo and adds it from its card', async ({ page, request }, testInfo) => {
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one });

    await page.goto('/echos');
    await expect(page.getByRole('link', { name: 'Echos, 1 new' })).toBeVisible({ timeout: 20_000 });
    const card = page.getByRole('region', { name: DISCOVERED_TWO });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Add' }).click();

    // The dialog opens at Step 2 with that Echo (spec §5.2).
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Add ${DISCOVERED_TWO}?` })).toBeVisible();
    if (isMobile(testInfo)) {
      // Poll: the dialog opens with a zoom-in animation (95% → 100%), and a
      // single measurement during it reads ~367 px (the CI flake of this test).
      await expect
        .poll(async () => (await dialog.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(370);
    }
    await saveScreenshot(page, testInfo, 'setup-discovered', { fullPage: false });

    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();

    await dialog.getByRole('button', { name: 'Living room' }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByRole('heading', { name: /^Say:/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Skip' }).click();

    await expect(dialog.getByRole('heading', { name: 'Living room is ready' })).toBeVisible();
    await expect(dialog.getByText('Pair it with your other Echos')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    const added = page.getByRole('region', { name: 'Living room' });
    await expect(added.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(added.getByText('Secured', { exact: true })).toBeVisible();
    // The badge is gone once the Echo is added.
    await expect(page.getByRole('link', { name: 'Echos', exact: true })).toBeVisible();
  });

  test('ignores a discovered Echo and stops ignoring it', async ({ page, request }) => {
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one });

    await page.goto('/echos');
    const card = page.getByRole('region', { name: DISCOVERED_TWO });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Echos, 1 new' })).toBeVisible();

    await card.getByRole('button', { name: 'Ignore' }).click();
    await expect(card).toBeHidden();
    await expect(page.getByRole('link', { name: 'Echos', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Show ignored (1)' }).click();
    await page.getByRole('button', { name: 'Stop ignoring' }).click();
    await expect(page.getByRole('region', { name: DISCOVERED_TWO })).toBeVisible();
  });

  test('adds an Echo secured by another app with a pasted key', async ({ page, request }) => {
    await page.goto('/setup');
    await page.getByRole('button', { name: 'Enter an address instead' }).first().click();
    await page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Port', { exact: true }).fill(String(FAKE_ECHO_PORTS.keyed));
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'This Echo is already secured.' })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByLabel('Key', { exact: true }).fill(WRONG_KEY);
    await page.getByRole('button', { name: 'Use this key' }).click();
    await expect(page.getByText("This is not the Echo's key.")).toBeVisible();

    await page.getByLabel('Key', { exact: true }).fill(FAKE_ECHO_KEY);
    await page.getByRole('button', { name: 'Use this key' }).click();
    await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Study');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: /^Say:/ })).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { name: 'Study is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // Done resets the page's flow and the Echo is added.
    await expect(page.getByRole('heading', { name: 'Choose your Echo' })).toBeVisible();
    const devices = (await (await request.get('/api/devices')).json()) as { name: string }[];
    expect(devices.map((device) => device.name)).toEqual(['Study']);
  });

  test('fixes the reply address from Step 3', async ({ page, request }) => {
    // An address nothing answers on: the Echo cannot download the chime.
    await patchSetting(request, 'network.replyBaseUrl', 'http://127.0.0.1:9');

    await page.goto('/setup');
    await page.getByRole('button', { name: 'Enter an address instead' }).first().click();
    await page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Port', { exact: true }).fill(String(FAKE_ECHO_PORTS.two));
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: `Add ${DISCOVERED_TWO}?` })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Your Echo cannot reach Cortecho' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByLabel('Address', { exact: true }).fill('http://127.0.0.1:3200');
    await page.getByRole('button', { name: 'Save and play again' }).click();

    await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Kitchen');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { name: 'Kitchen is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    const settings = await readSettings(request);
    expect(settings.effective['network.replyBaseUrl']).toBe('http://127.0.0.1:3200');
  });

  test('adds an Echo by address when nothing was found', async ({ page, request }) => {
    // Ignoring both discoverable simulators is the "nothing found" state.
    await request.post('/api/discovery/ignore', { data: { mac: '020000000001' } });
    await request.post('/api/discovery/ignore', { data: { mac: '020000000002' } });

    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'No Echo found yet' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Enter an address instead' }).first().click();
    await page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Port', { exact: true }).fill(String(FAKE_ECHO_PORTS.hidden));
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Add Echo Dot 2 000004?' })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Study');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    const devices = (await (await request.get('/api/devices')).json()) as { name: string }[];
    expect(devices.map((device) => device.name)).toEqual(['Study']);
  });

  test('plays a test sound from Settings → Network', async ({ page, request }) => {
    await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one });
    await patchSetting(request, 'network.replyBaseUrl', 'http://127.0.0.1:3200');

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await openSettingsSection(page, 'network');
    await expect(page.getByLabel('Reply address', { exact: true })).toHaveValue('http://127.0.0.1:3200');
    await page.getByRole('button', { name: 'Play a test sound' }).click();
    await expect(page.getByText('Downloaded and played.')).toBeVisible({ timeout: 15_000 });
  });
});
