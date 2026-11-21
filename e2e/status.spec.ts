import { expect, test } from '@playwright/test';
import {
  completeSetup,
  createDevice,
  deleteDevice,
  FAKE_ECHO_PORTS,
  saveScreenshot,
  waitForStatus,
} from './helpers.ts';

// The e2e server runs without a real Echo and without OPENAI_API_KEY (see
// playwright.config.ts). Two FakeEchos listen on localhost for the device
// flows; one device below points at a refused port to show "Disconnected".

test.describe('Status page', () => {
  // This install is set up: `/` must not send anyone to the onboarding.
  test.beforeEach(async ({ request }) => {
    await completeSetup(request);
  });

  test('shows the configured Echo, pipeline and OpenAI state', async ({ page, request }, testInfo) => {
    const device = await createDevice(request, { name: 'Kitchen', port: 9 });
    try {
      await page.goto('/');
      await waitForStatus(page);
      const card = page.getByRole('region', { name: device.name });
      await expect(card.getByText('Disconnected')).toBeVisible();
      await expect(card.getByText('127.0.0.1:9')).toBeVisible();
      await expect(card.getByText('Plaintext')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Pipeline' }).getByText(/echo_test/)).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'OpenAI' }).getByText('OPENAI_API_KEY missing'),
      ).toBeVisible();
      await saveScreenshot(page, testInfo, 'status');
    } finally {
      await deleteDevice(request, device.id);
    }
  });

  test('shows the empty state without devices', async ({ page, request }) => {
    // Other tests clean up after themselves; the list starts empty.
    expect(await (await request.get('/api/devices')).json()).toEqual([]);
    await page.goto('/');
    await waitForStatus(page);
    await expect(page.getByText('No Echo is configured yet.')).toBeVisible();
  });

  test('Say is disabled while no Echo is connected', async ({ page, request }) => {
    const device = await createDevice(request, { name: 'Kitchen', port: 9, kind: 'echo' });
    try {
      await page.goto('/');
      await waitForStatus(page);
      await page.getByLabel(/Ask the agent/).fill('Hello');
      await expect(page.getByRole('button', { name: /Ask/ })).toBeEnabled();
      await expect(page.getByRole('button', { name: /Say on all Echos/ })).toBeDisabled();
    } finally {
      await deleteDevice(request, device.id);
    }
  });

  test('Ask without an API key shows the error and records the turn', async ({ page }) => {
    await page.goto('/');
    await waitForStatus(page);
    await page.getByLabel(/Ask the agent/).fill('What time is it?');
    await page.getByRole('button', { name: /Ask/ }).click();
    await expect(page.getByText(/OpenAI is not configured/)).toBeVisible();
    const turns = page.getByRole('region', { name: 'Latest turns' });
    await expect(turns.getByText('“What time is it?”').first()).toBeVisible();
    await expect(turns.getByText('Error', { exact: true }).first()).toBeVisible();
  });

  test('shows two Echo cards, filters turns and reports Say per device', async ({ page, request }) => {
    const kitchen = await createDevice(request, { name: 'Kitchen', port: FAKE_ECHO_PORTS.one });
    const bedroom = await createDevice(request, { name: 'Bedroom', port: FAKE_ECHO_PORTS.two });
    try {
      await page.goto('/');
      await waitForStatus(page);
      const kitchenCard = page.getByRole('region', { name: 'Kitchen' });
      const bedroomCard = page.getByRole('region', { name: 'Bedroom' });
      await expect(kitchenCard.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(bedroomCard.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(kitchenCard.getByText('Plaintext', { exact: true })).toBeVisible();

      // The turns filter refetches with that Echo's id.
      const filtered = page.waitForRequest((request) =>
        request.url().includes(`/api/turns?limit=20&deviceId=${kitchen.id}`),
      );
      await page.getByLabel('Echo', { exact: true }).selectOption(String(kitchen.id));
      await filtered;

      // Say on one Echo: the result list names it, and the missing key is its own row.
      await page.getByLabel(/Ask the agent/).fill('Hello from the test');
      await page.getByLabel('Say on', { exact: true }).selectOption(String(kitchen.id));
      await page.getByRole('button', { name: 'Say on Kitchen' }).click();
      const results = page.getByRole('list', { name: 'Say results' });
      await expect(results.getByText(/Kitchen/)).toBeVisible({ timeout: 15_000 });
      await expect(results.getByText(/OpenAI is not configured/)).toBeVisible();

      // Ask offers the web session and each Echo's own memory.
      await expect(page.getByLabel('Ask on').locator('option')).toHaveCount(3);
    } finally {
      await deleteDevice(request, kitchen.id);
      await deleteDevice(request, bedroom.id);
    }
  });

  test('the health endpoint is public JSON for monitoring, with devices', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { status: string; devices: unknown[]; settingsVersion: number };
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.devices)).toBe(true);
    expect(typeof body.settingsVersion).toBe('number');
  });
});

test('searched answers show clickable inline sources', async ({ page }) => {
  await page.route('**/api/turns*', (route) =>
    route.fulfill({
      json: [
        {
          id: 999,
          source: 'ask',
          outcome: 'answered',
          startedAt: new Date().toISOString(),
          deviceId: null,
          deviceName: null,
          settingsVersion: 1,
          transcript: 'Search for a fact',
          reply: 'Fact.',
          displayText: 'Fact. [1]',
          citations: [{ start: 6, end: 9, url: 'https://example.com/source', title: 'Example source' }],
          toolCalls: [],
          timings: {},
          error: null,
        },
      ],
    }),
  );
  await page.goto('/');
  const source = page.getByRole('link', { name: '[Example source]' });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', 'https://example.com/source');
});
