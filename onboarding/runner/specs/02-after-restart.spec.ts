import { type APIRequestContext, expect, test } from '@playwright/test';
import { type EchoRun, type EchoState, echoJson, waitFor } from '../lib/echo.ts';
import { OPENAI_MODE } from '../lib/env.ts';
import { collectFacts, type ReconnectFact } from '../lib/facts.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

type Device = { id: number; kind: string; name: string; state: string; hasKey: boolean; encryption: string };
type Turn = { id: number; transcript: string | null; outcome: string };

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  const response = await request.get('/api/devices');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Device[];
}

async function readTurns(request: APIRequestContext, deviceId: number): Promise<Turn[]> {
  const response = await request.get(`/api/turns?limit=1&deviceId=${deviceId}`);
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Turn[];
}

test.describe('After a restart', { tag: '@restart' }, () => {
  test('The Echo keeps working after the container and the Echo restart', async ({
    page,
    request,
  }, testInfo) => {
    const steps: StepFact[] = [];
    const reconnects: ReconnectFact[] = [];
    let failure: unknown;
    try {
      const devices = await listDevices(request);
      const device = devices.find((candidate) => candidate.kind === 'echo');
      if (!device) throw new Error('the onboarded Echo is not in /api/devices');
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

      await runStep(
        testInfo,
        page,
        10,
        'Drop the link',
        'drop-link',
        async (capture) => {
          const startedAt = Date.now();
          await echoJson('/drop', { method: 'POST' });
          await waitFor(
            async () => {
              const state = await echoJson<EchoState>('/state');
              return state.subscribed && state.encrypted;
            },
            { what: 'the Echo to reconnect after the drop', timeoutMs: 60_000 },
          );
          await waitFor(
            async () => {
              const current = (await listDevices(request)).find((candidate) => candidate.id === device.id);
              return current?.state === 'connected' && current.encryption === 'noise';
            },
            { what: 'Cortecho to reconnect the dropped link', timeoutMs: 60_000 },
          );
          reconnects.push({ kind: 'drop', ms: Date.now() - startedAt });
          await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
          await expect(card.getByText('Encrypted (API key)')).toBeVisible();
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        11,
        'Reboot the Echo',
        'reboot-echo',
        async (capture) => {
          const startedAt = Date.now();
          await echoJson('/reboot', { method: 'POST' });
          await waitFor(
            async () => {
              const state = await echoJson<EchoState>('/state');
              return (
                state.keyState === 'set' && state.subscribed && state.encrypted && state.timeAnswers.keyed
              );
            },
            { what: 'the Echo to reconnect with its stored key after the reboot', timeoutMs: 90_000 },
          );
          await waitFor(
            async () => {
              const current = (await listDevices(request)).find((candidate) => candidate.id === device.id);
              return current?.state === 'connected' && current.encryption === 'noise';
            },
            { what: 'Cortecho to reconnect after the reboot', timeoutMs: 60_000 },
          );
          reconnects.push({ kind: 'reboot', ms: Date.now() - startedAt });
          await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
          await expect(card.getByText('Encrypted (API key)')).toBeVisible();
          await capture();
        },
        steps,
      );

      await runStep(
        testInfo,
        page,
        12,
        'Voice after restart',
        'voice-after-restart',
        async (capture) => {
          const before = await readTurns(request, device.id);
          const baseline = before[0]?.id ?? 0;
          const wake = await echoJson<{ runId: number }>('/wake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fixture: 'what-time-is-it' }),
          });
          const run = await waitFor<EchoRun>(
            async () => {
              const current = await echoJson<EchoRun>(`/runs/${wake.runId}`);
              return current.done ? current : null;
            },
            { what: 'the wake-word run to finish after the restart', timeoutMs: 90_000 },
          );
          expect(run.outcome).toBe('answered');
          expect(run.runEnd).toBe(true);
          expect(run.played.some((item) => item.kind === 'reply')).toBe(true);

          const turn = await waitFor<Turn>(
            async () => {
              const latest = (await readTurns(request, device.id))[0];
              return latest && latest.id > baseline ? latest : null;
            },
            { what: 'the new turn in the history', timeoutMs: 30_000 },
          );
          expect(turn.outcome).toBe('answered');
          if (OPENAI_MODE === 'real') expect((turn.transcript ?? '').toLowerCase()).toContain('time');
          else expect(turn.transcript).toBe('What time is it?');

          await page.goto('/');
          const turns = page.getByRole('region', { name: 'Latest turns' });
          await expect(turns).toBeVisible();
          await expect(turns).toContainText(OPENAI_MODE === 'real' ? /time/i : 'What time is it?', {
            timeout: 30_000,
          });
          await capture();
        },
        steps,
      );
    } catch (error) {
      failure = error;
    }

    await collectFacts(steps, { reconnects }).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
  });
});
