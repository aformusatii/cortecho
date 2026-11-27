import { type APIRequestContext, expect, test } from '@playwright/test';
import {
  type EchoRun,
  type EchoState,
  echoJson,
  gatewayJson,
  type OpenAiCall,
  waitFor,
} from '../lib/echo.ts';
import { ECHO_FRIENDLY_NAME, ECHO_HOST, ECHO_PORT, OPENAI_MODE, REPLY_ORIGIN } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

type Setup = { onboardingDone: boolean; hasEcho: boolean };
type Discovery = {
  found: Array<{ host: string; port: number; source: string; friendlyName: string }>;
};
type Device = { id: number; kind: string; name: string; state: string; hasKey: boolean; encryption: string };

async function readSetup(request: APIRequestContext): Promise<Setup> {
  const response = await request.get('/api/setup');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Setup;
}

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  const response = await request.get('/api/devices');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Device[];
}

test.describe('Onboarding', { tag: '@setup' }, () => {
  test('A new Echo Dot is onboarded on a fresh install', async ({ page, request }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      await runStep(
        testInfo,
        page,
        1,
        'Fresh install',
        'fresh-install',
        async (capture) => {
          await page.goto('/');
          await expect(page).toHaveURL(/\/setup$/);
          await expect(page.getByRole('heading', { name: 'Welcome to Cortecho' })).toBeVisible();
          await expect(page.getByText('Step 1 of 4')).toBeVisible();
          const setup = await readSetup(request);
          expect(setup.onboardingDone).toBe(false);
          await capture();
          await page.getByRole('button', { name: 'Get started' }).click();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        2,
        'Your home',
        'your-home',
        async (capture) => {
          await expect(page.getByRole('heading', { name: 'Your home' })).toBeVisible();
          await expect(page.getByText('Step 2 of 4')).toBeVisible();
          await page.getByLabel('Time zone', { exact: true }).fill('Europe/Chisinau');
          await page.getByLabel('Locale', { exact: true }).selectOption('en-GB');
          await capture();
          await page.getByRole('button', { name: 'Next' }).click();
          await expect(page.getByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        3,
        'Connect OpenAI',
        'connect-openai',
        async (capture) => {
          await expect(page.getByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
          await expect(page.getByText('Step 3 of 4')).toBeVisible();
          await page.getByLabel('API key', { exact: true }).fill('sk-onboarding-gateway');
          await capture();
          await page.getByRole('button', { name: 'Check and continue' }).click();
          await expect(page.getByRole('heading', { name: 'Add your Echo' })).toBeVisible({ timeout: 30_000 });
          await waitFor(
            async () =>
              (await gatewayJson<OpenAiCall[]>('/calls')).some(
                (call) => call.method === 'GET' && call.path === '/v1/models',
              ),
            { what: 'the server-side OpenAI check at the gateway', timeoutMs: 15_000 },
          );
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        4,
        'Discovery',
        'discovery',
        async (capture) => {
          await expect(page.getByRole('heading', { name: 'Add your Echo' })).toBeVisible();
          await expect(page.getByText('Step 4 of 4')).toBeVisible();
          const radio = page.getByRole('radio', {
            name: new RegExp(ECHO_FRIENDLY_NAME.replace(/\./g, '\\.')),
          });
          await expect(radio).toBeVisible({ timeout: 60_000 });

          const response = await request.get('/api/discovery');
          const body = await response.text();
          expect(response.status(), body).toBe(200);
          const discovery = JSON.parse(body) as Discovery;
          const found = discovery.found.find((echo) => echo.host === ECHO_HOST && echo.port === ECHO_PORT);
          expect(found, `the scan should list ${ECHO_HOST}:${ECHO_PORT}`).toBeTruthy();
          expect(['scan', 'both']).toContain(found?.source);

          await capture();
          await radio.check();
          await page.getByRole('button', { name: 'Next' }).click();
          await expect(
            page.getByRole('heading', { name: `Add ${ECHO_FRIENDLY_NAME}?`, exact: true }),
          ).toBeVisible();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        5,
        'Adopt',
        'adopt',
        async (capture) => {
          await page.getByRole('button', { name: 'Add', exact: true }).click();
          await expect(page.getByText('Did you hear it?')).toBeVisible({ timeout: 60_000 });
          const state = await echoJson<EchoState>('/state');
          expect(state.keyState).toBe('set');
          expect(state.encrypted).toBe(true);
          expect(state.subscribed).toBe(true);
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        6,
        'Identify',
        'identify',
        async (capture) => {
          const state = await echoJson<EchoState>('/state');
          const chime = state.played.find((item) => item.kind === 'announcement' && item.format === 'wav');
          expect(chime, 'the Echo should have downloaded the chime as WAV').toBeTruthy();
          expect(chime?.url.startsWith(REPLY_ORIGIN)).toBe(true);

          await page.getByRole('button', { name: 'Yes', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Where is this Echo?' })).toBeVisible();
          await capture();
          await page.getByRole('button', { name: 'Kitchen' }).click();
          await page.getByRole('button', { name: 'Next' }).click();
          await expect(page.getByRole('heading', { name: /^Say:/ })).toBeVisible();
        },
        steps,
      );

      const devices = await listDevices(request);
      const device = devices.find((candidate) => candidate.kind === 'echo');
      if (!device) throw new Error('the adopted Echo is not in /api/devices');

      await runStep(
        testInfo,
        page,
        7,
        'Try it',
        'try-it',
        async (capture) => {
          await expect(page.getByRole('heading', { name: /^Say:/ })).toBeVisible();
          const wake = await echoJson<{ runId: number }>('/wake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fixture: 'what-time-is-it' }),
          });

          const heard = page.getByText(/✓ Heard/);
          await expect(heard).toBeVisible({ timeout: 90_000 });
          const heardText = (await heard.textContent()) ?? '';
          if (OPENAI_MODE === 'real') expect(heardText.toLowerCase()).toContain('time');
          else expect(heardText).toContain('What time is it?');
          await expect(page.getByText(/answered in [\d.]+ s/)).toBeVisible();
          await capture();

          const run = await waitFor<EchoRun>(
            async () => {
              const current = await echoJson<EchoRun>(`/runs/${wake.runId}`);
              return current.done ? current : null;
            },
            { what: 'the wake-word run to finish', timeoutMs: 90_000 },
          );
          expect(run.outcome).toBe('answered');
          expect(run.runEnd).toBe(true);
          const reply = run.played.find((item) => item.kind === 'reply');
          expect(reply, 'the Echo should have downloaded the spoken reply').toBeTruthy();
          expect(['wav', 'mp3']).toContain(reply?.format);
          expect(reply?.url.startsWith(REPLY_ORIGIN)).toBe(true);

          await expect(page.getByRole('heading', { name: 'Kitchen is ready' })).toBeVisible({
            timeout: 30_000,
          });
          await page.getByRole('button', { name: 'Continue' }).click();
          await expect(page.getByRole('heading', { name: 'Cortecho is ready' })).toBeVisible();
          await expect(page.getByText('to Kitchen any time')).toBeVisible();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        8,
        'Status',
        'status',
        async (capture) => {
          await page.getByRole('button', { name: 'Go to Status' }).click();
          await expect(page).toHaveURL(/\/$/);
          const card = page.getByRole('region', { name: 'Kitchen' });
          await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
          await expect(card.getByText('Encrypted (API key)')).toBeVisible();

          const state = await echoJson<EchoState>('/state');
          expect(state.timeAnswers.keyed).toBe(true);

          const currentDevices = await listDevices(request);
          expect(currentDevices).toHaveLength(1);
          expect(currentDevices[0]).toMatchObject({ kind: 'echo', hasKey: true, encryption: 'noise' });
          expect((await readSetup(request)).onboardingDone).toBe(true);
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
