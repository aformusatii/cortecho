import { type APIRequestContext, expect, test } from '@playwright/test';
import { collectFacts } from '../lib/facts.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

type Device = { id: number; kind: string; name: string };

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  const response = await request.get('/api/devices');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Device[];
}

type TourPage = {
  slug: string;
  label: string;
  path: string;
  /** The marker that the page (or its tab) has rendered. */
  ready: () => Promise<void>;
  /** An interaction the page needs before its screenshot (History). */
  open?: () => Promise<void>;
};

/**
 * Browser-generated console errors that are not application errors. The lab is
 * served over plain HTTP on a private /24 (the Echo needs an IP, not
 * localhost), so Chromium reports that it ignores the Cross-Origin-Opener-Policy
 * header and that some features are unavailable on an untrustworthy origin.
 */
const BROWSER_NOISE = [/^The Cross-Origin-Opener-Policy header has been ignored/, /is not a secure context/];

// One screenshot per page at the two required widths. This is the only place
// the whole UI is rendered at a phone width after onboarding; the rest of the
// lab drives narrow flows one at a time.
test.describe('UI tour', { tag: '@integration' }, () => {
  test('Every page renders at 1280 and 375 with no console or request errors', async ({
    page,
    request,
  }, testInfo) => {
    const steps: StepFact[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    let failure: unknown;

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (BROWSER_NOISE.some((pattern) => pattern.test(text))) return;
      consoleErrors.push(text);
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'unknown';
      // Navigation cancels in-flight requests; that is not a failed request.
      if (reason.includes('ERR_ABORTED')) return;
      failedRequests.push(`${request.method()} ${request.url()}: ${reason}`);
    });

    try {
      const device = (await listDevices(request)).find((candidate) => candidate.kind === 'echo');
      if (!device) throw new Error('the onboarded Echo is not in /api/devices');

      const pages: TourPage[] = [
        {
          slug: 'status',
          label: 'Status',
          path: '/',
          ready: async () => {
            await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
            await expect(page.getByRole('region', { name: 'Latest turns' })).toBeVisible();
          },
        },
        {
          slug: 'echos',
          label: 'Echos',
          path: '/echos',
          ready: async () => {
            await expect(page.getByRole('heading', { name: 'Echos', level: 1 })).toBeVisible();
            await expect(page.getByRole('region', { name: device.name })).toBeVisible();
          },
        },
        {
          slug: 'echo',
          label: 'Echo detail',
          path: `/echos/${device.id}`,
          ready: async () => {
            await expect(page.getByRole('heading', { name: device.name, level: 1 })).toBeVisible();
          },
        },
        {
          slug: 'settings',
          label: 'Settings',
          path: '/settings',
          ready: async () => {
            await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
          },
        },
        {
          slug: 'providers',
          label: 'Providers',
          path: '/settings?tab=providers',
          ready: async () => {
            await expect(page.getByTestId('provider-openai')).toBeVisible();
          },
        },
        {
          slug: 'connectors',
          label: 'Connectors',
          path: '/settings?tab=connectors',
          ready: async () => {
            await expect(page.getByTestId('connector-tool-count')).toBeVisible();
          },
        },
        {
          slug: 'history',
          label: 'History',
          path: '/settings',
          ready: async () => {
            await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
          },
          open: async () => {
            await page.getByRole('button', { name: 'History', exact: true }).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog.getByRole('heading', { name: 'Settings history' })).toBeVisible();
          },
        },
      ];

      const widths = [1280, 375] as const;
      for (const [pageIndex, tourPage] of pages.entries()) {
        for (const [widthIndex, width] of widths.entries()) {
          const n = 15 + pageIndex * widths.length + widthIndex;
          await runStep(
            testInfo,
            page,
            n,
            `${tourPage.label} (${width}px)`,
            `${tourPage.slug}-${width}`,
            async (capture) => {
              await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
              consoleErrors.length = 0;
              failedRequests.length = 0;
              await page.goto(tourPage.path);
              await tourPage.ready();
              await tourPage.open?.();
              await capture();
              expect(consoleErrors, `console errors on ${tourPage.label} at ${width}px`).toEqual([]);
              expect(failedRequests, `failed requests on ${tourPage.label} at ${width}px`).toEqual([]);
            },
            steps,
            { page: tourPage.label, width },
          );
        }
      }
    } catch (error) {
      failure = error;
    }

    await collectFacts(steps).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
  });
});
