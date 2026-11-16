import { type APIRequestContext, expect, type Page, type TestInfo } from '@playwright/test';

export const isMobile = (testInfo: TestInfo) => testInfo.project.name === 'mobile';

/** The two FakeEchos started by playwright.config.ts (e2e/fake-echo-server.ts). */
export const FAKE_ECHO_PORTS = { one: 26101, two: 26102 } as const;

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

/** The status page has loaded the health document (the OpenAI card always renders). */
export async function waitForStatus(page: Page) {
  await expect(page.getByRole('region', { name: 'OpenAI' })).toBeVisible();
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
