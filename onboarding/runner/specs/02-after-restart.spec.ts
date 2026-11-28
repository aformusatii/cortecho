import { type APIRequestContext, expect, test } from '@playwright/test';
import { waitFor } from '../lib/echo.ts';
import { collectFacts } from '../lib/facts.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

type Device = { id: number; kind: string; name: string; state: string; hasKey: boolean; encryption: string };

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  const response = await request.get('/api/devices');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Device[];
}

// run.sh restarts the container between the setup and restart phases. Both the
// persisted device row and the encryption key must survive it: this is the one
// thing the restart phase is for (the Echo reboot/drop variations are covered
// by the API unit tests).
test.describe('After a restart', { tag: '@restart' }, () => {
  test('The Echo is still connected and encrypted after the container restart', async ({
    page,
    request,
  }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      const devices = await listDevices(request);
      const onboarded = devices.find((candidate) => candidate.kind === 'echo');
      if (!onboarded) throw new Error('the onboarded Echo is not in /api/devices');
      // The app reconnects as soon as it starts; the health check happens
      // before the ESPHome link is necessarily up, so poll instead of racing.
      const device = await waitFor(
        async () => {
          const current = (await listDevices(request)).find((candidate) => candidate.id === onboarded.id);
          return current?.state === 'connected' ? current : null;
        },
        { what: 'the Echo to reconnect after the restart', timeoutMs: 60_000 },
      );
      expect(device).toMatchObject({ hasKey: true, encryption: 'noise' });
      const card = page.getByRole('region', { name: 'Kitchen' });

      await runStep(
        testInfo,
        page,
        9,
        'After restart',
        'after-restart',
        async (capture) => {
          await page.goto('/');
          await expect(page).toHaveURL(/\/$/);
          await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Welcome to Cortecho' })).toHaveCount(0);
          await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
          await expect(card.getByText('Encrypted (API key)')).toBeVisible();
          await capture();
        },
        steps,
      );
    } catch (error) {
      failure = error;
    }

    await collectFacts(steps).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
  });
});
