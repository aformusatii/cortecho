import type { DiscoveryDocument, SettingsDocument, SetupDocument } from '@cortecho/shared';
import { type APIRequestContext, expect, type Page, type TestInfo } from '@playwright/test';
import { FAKE_ECHO_CONTROL_PORT, FAKE_ECHO_KEY, FAKE_ECHO_PORTS } from './fake-echo-config.ts';

export const isMobile = (testInfo: TestInfo) => testInfo.project.name === 'mobile';

/**
 * The FakeEchos started by playwright.config.ts (e2e/fake-echo-server.ts):
 * one and two are discoverable, keyed has a key from the start, hidden is only
 * reachable by its address.
 */
export { FAKE_ECHO_KEY, FAKE_ECHO_PORTS };

/**
 * Saves a screenshot to docs/screenshots/<project>-<name>.png.
 * Use `fullPage: false` while a modal is open: fixed overlays only cover the
 * viewport, so a full-page capture would look broken.
 */
export async function saveScreenshot(page: Page, testInfo: TestInfo, name: string, { fullPage = true } = {}) {
  await page.screenshot({
    path: `docs/screenshots/${testInfo.project.name}-${name}.png`,
    fullPage,
    animations: 'disabled',
  });
}

/** The status page has loaded the health document (the Providers card always renders). */
export async function waitForStatus(page: Page) {
  await expect(page.getByRole('region', { name: 'Providers' })).toBeVisible();
}

/** A device on a FakeEcho (kind `test` by default, so it is not announced to). */
export async function createDevice(
  request: APIRequestContext,
  { name, port, kind = 'test' }: { name: string; port: number; kind?: 'echo' | 'test' },
) {
  const response = await request.post('/api/devices', {
    data: { name, kind, host: '127.0.0.1', port },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: number; name: string; port: number };
}

export async function deleteDevice(request: APIRequestContext, id: number) {
  await request.delete(`/api/devices/${id}`);
}

export async function deleteAllDevices(request: APIRequestContext): Promise<void> {
  const devices = (await (await request.get('/api/devices')).json()) as { id: number }[];
  for (const device of devices) await deleteDevice(request, device.id);
}

/** The simulator's control server: forget every key (see fake-echo-server.ts). */
export async function resetFakeEchos(request: APIRequestContext): Promise<void> {
  const response = await request.post(`http://127.0.0.1:${FAKE_ECHO_CONTROL_PORT}/reset`);
  expect(response.status(), await response.text()).toBe(204);
}

export async function clearDiscoveryIgnores(request: APIRequestContext): Promise<void> {
  const document = (await (await request.get('/api/discovery')).json()) as DiscoveryDocument;
  for (const echo of document.found) {
    if (echo.ignored) await request.delete(`/api/discovery/ignore/${echo.mac}`);
  }
}

export async function readSettings(request: APIRequestContext): Promise<SettingsDocument> {
  const response = await request.get('/api/settings');
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as SettingsDocument;
}

/** Writes one setting through the versioned API, like the settings form does. */
export async function patchSetting(request: APIRequestContext, key: string, value: unknown): Promise<void> {
  const document = await readSettings(request);
  const response = await request.patch('/api/settings', {
    data: { version: document.version, changes: { [key]: value } },
  });
  expect(response.status(), await response.text()).toBe(200);
}

export async function readSetup(request: APIRequestContext): Promise<SetupDocument> {
  const response = await request.get('/api/setup');
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as SetupDocument;
}

/**
 * Whatever the previous test did, an install is treated as set up: the flag is
 * written and a key a failed test might have stored is cleared, so `/` never
 * redirects and the OpenAI cards keep saying "missing".
 */
export async function completeSetup(request: APIRequestContext): Promise<void> {
  await patchSetting(request, 'openai.apiKey', null);
  const response = await request.post('/api/setup/complete');
  expect(response.status(), await response.text()).toBe(200);
}

/** Back to the first launch: the onboarding shows again (used by the onboarding spec). */
export async function restartSetup(request: APIRequestContext): Promise<void> {
  const response = await request.delete('/api/setup/complete');
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * A known starting point for the setup specs: no devices, no ignored MACs, no
 * reply address, every simulator unkeyed again, and the onboarding finished.
 * Deleting the devices first keeps the key reset away from a live link.
 */
export async function cleanSetupState(request: APIRequestContext): Promise<void> {
  await deleteAllDevices(request);
  await clearDiscoveryIgnores(request);
  await patchSetting(request, 'network.replyBaseUrl', '');
  await resetFakeEchos(request);
  await completeSetup(request);
}

/**
 * On a phone the settings sections are <details> accordions; on tablet and
 * desktop they are plain sections. Open one when it is collapsed.
 */
export async function openSettingsSection(page: Page, section: string) {
  const details = page.locator(`#section-${section}`);
  if ((await details.evaluate((element) => element.tagName)) !== 'DETAILS') return;
  if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await details.locator('summary').first().click();
}

/** The `v<number>` badge in the Settings header. */
export async function settingsVersion(page: Page): Promise<number> {
  const text = await page.getByTestId('settings-version').textContent();
  return Number(text?.replace('v', ''));
}
