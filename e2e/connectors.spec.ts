import { expect, test } from '@playwright/test';
import { completeSetup, createDevice, deleteDevice, FAKE_ECHO_PORTS, saveScreenshot } from './helpers.ts';

const OPEN_MCP = 'http://127.0.0.1:26201/mcp';
const AUTH_MCP = 'http://127.0.0.1:26200/mcp';

function unique(label: string) {
  const slug = `e2e${Math.random().toString(36).slice(2, 7)}`;
  return { slug, name: `${label} ${slug}` };
}

async function connectorByName(
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<{ id: number; state: string; authState: string; toolsEnabled: number } | undefined> {
  const response = await request.get('/api/mcp/servers');
  const list = (await response.json()) as {
    id: number;
    name: string;
    state: string;
    authState: string;
    toolsEnabled: number;
  }[];
  return list.find((item) => item.name === name);
}

async function deleteConnector(request: import('@playwright/test').APIRequestContext, name: string) {
  const found = await connectorByName(request, name);
  if (found) await request.delete(`/api/mcp/servers/${found.id}`);
}

async function openAdd(
  page: import('@playwright/test').Page,
  values: { name: string; slug: string; url: string; auth?: 'oauth' },
) {
  await page.goto('/settings?tab=connectors');
  await expect(page.getByRole('button', { name: 'Connectors', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Add connector', exact: true }).click();
  await page.getByRole('button', { name: /Custom MCP server/ }).click();
  await page.getByLabel('Name', { exact: true }).fill(values.name);
  await page.getByLabel('Slug', { exact: true }).fill(values.slug);
  await page.getByLabel('Server URL', { exact: true }).fill(values.url);
  if (values.auth === 'oauth') {
    await page.getByLabel('Sign-in', { exact: true }).selectOption('oauth');
  }
}

test.describe('Connectors', () => {
  test.beforeEach(async ({ request }) => {
    await completeSetup(request);
  });

  test('adds a connector, lists tools, tries one and limits it per Echo', async ({
    page,
    request,
  }, testInfo) => {
    const { slug, name } = unique('Open');
    const device = await createDevice(request, {
      name: `Conn ${slug}`,
      port: FAKE_ECHO_PORTS.one,
      kind: 'test',
    });
    try {
      await openAdd(page, { name, slug, url: OPEN_MCP });
      await page.getByRole('button', { name: 'Save and connect' }).click();

      // Scope to the page: the success toast (a sonner listitem) also carries
      // the connector name, so an unscoped listitem locator saw two matches.
      const card = page.getByRole('main').getByRole('listitem').filter({ hasText: name });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByText('Connected')).toBeVisible();
      await expect(page.getByTestId('connector-tool-count')).toContainText('tools offered');
      await saveScreenshot(page, testInfo, 'connectors', { fullPage: false });

      await card.getByRole('button', { name: 'Manage' }).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText(name, { exact: true })).toBeVisible();
      await sheet.getByRole('tab', { name: 'Tools' }).click();
      const echoRow = sheet.getByRole('listitem').filter({ hasText: 'Echo' }).first();
      await expect(echoRow).toBeVisible();

      await echoRow.getByRole('button', { name: 'Try', exact: true }).click();
      const tryDialog = page.getByRole('dialog').filter({ hasText: 'Try Echo' });
      await tryDialog.getByLabel('Arguments (JSON object)').fill(JSON.stringify({ text: 'hello from e2e' }));
      await tryDialog.getByRole('button', { name: 'Run tool' }).click();
      await expect(tryDialog.getByText(/fake says hello from e2e/)).toBeVisible({ timeout: 15_000 });
      await tryDialog.getByRole('button', { name: 'Close', exact: true }).first().click();

      // Per-Echo availability writes the connectors.disabled override.
      await page.goto(`/echos/${device.id}?tab=connectors`);
      const toggle = page.getByRole('switch', { name: `${device.name} may use ${name}` });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect
        .poll(async () => {
          const response = await request.get(`/api/devices/${device.id}/settings`);
          const document = (await response.json()) as { overrides: Record<string, unknown> };
          return document.overrides['connectors.disabled'];
        })
        .toContain(slug);

      await page.goto('/settings?tab=connectors');
      const reloaded = page.getByRole('main').getByRole('listitem').filter({ hasText: name });
      await reloaded.getByRole('button', { name: 'Manage' }).click();
      await page.getByRole('dialog').getByRole('tab', { name: 'Delete' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: `Delete ${name}` })
        .click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await deleteConnector(request, name);
      await deleteDevice(request, device.id);
    }
  });

  test('signs in to an OAuth connector in a new tab', async ({ page, request }, testInfo) => {
    const { slug, name } = unique('OAuth');
    try {
      await openAdd(page, { name, slug, url: AUTH_MCP, auth: 'oauth' });
      const popupPromise = page.context().waitForEvent('page');
      await page.getByRole('button', { name: 'Save and sign in' }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      // The callback 302s to /settings?tab=connectors&server=N&auth=ok, and the
      // page consumes those params at once (onConsumed clears them), so the
      // query string is transient — slow CI runners missed it. Assert where
      // the popup ends up and let the API polls below prove the sign-in.
      await expect.poll(() => popup.url(), { timeout: 20_000 }).toContain('/settings');

      await expect
        .poll(async () => (await connectorByName(request, name))?.authState, { timeout: 20_000 })
        .toBe('signed-in');
      await expect
        .poll(async () => (await connectorByName(request, name))?.state, { timeout: 20_000 })
        .toBe('connected');
      await saveScreenshot(popup, testInfo, 'connectors-oauth', { fullPage: false });
      await popup.close();
    } finally {
      await deleteConnector(request, name);
    }
  });
});
