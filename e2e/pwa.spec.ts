import { expect, test } from '@playwright/test';
import { waitForStatus } from './helpers.ts';

// Installability = a valid manifest + a service worker that controls the
// page. Runs only in the desktop project (see playwright.config.ts).
test.describe('PWA', () => {
  test.use({ serviceWorkers: 'allow' });

  test('has a valid manifest with the required icons', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();

    const response = await request.get(new URL(href as string, page.url()).href);
    expect(response.ok()).toBe(true);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      name: 'Cortecho',
      short_name: 'Cortecho',
      display: 'standalone',
      start_url: '/',
      scope: '/',
    });
    expect(manifest.theme_color).toMatch(/^#/);
    expect(manifest.background_color).toMatch(/^#/);

    const icons: { src: string; sizes: string; purpose?: string }[] = manifest.icons;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose !== 'maskable')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    for (const icon of icons) {
      expect((await request.get(`/${icon.src}`)).ok(), icon.src).toBe(true);
    }

    for (const selector of ['link[rel="apple-touch-icon"]', 'link[rel="icon"][href$=".ico"]']) {
      const iconHref = await page.locator(selector).getAttribute('href');
      expect((await request.get(iconHref as string)).ok(), selector).toBe(true);
    }
  });

  test('registers a service worker and works offline as an app shell', async ({
    page,
    context,
  }, testInfo) => {
    await page.goto('/');
    await waitForStatus(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first visit installs the worker; it controls the page after a reload.
    await page.reload();
    await waitForStatus(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // API responses must never be cached.
    const cachedApiUrls = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys())
          urls.push(new URL(request.url).pathname);
      }
      return urls.filter((path) => path.startsWith('/api'));
    });
    expect(cachedApiUrls).toEqual([]);

    await context.setOffline(true);
    // A deep link works offline thanks to navigateFallback -> index.html.
    await page.goto('/some/deep/link');
    await expect(page.getByText('You are offline.')).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
    await expect(page.getByText('You are offline.')).toBeVisible();
    await expect(page.getByText('Could not load the status').first()).toBeVisible();
    await page.screenshot({ path: `docs/screenshots/${testInfo.project.name}-offline.png`, fullPage: true });

    // Back online: data loads again.
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await waitForStatus(page);
  });
});
