import { type APIRequestContext, expect, test } from '@playwright/test';
import {
  type EchoRun,
  type EchoState,
  echoJson,
  gatewayJson,
  type OpenAiCall,
  resetGatewayCalls,
  waitFor,
} from '../lib/echo.ts';
import { OPENAI_MODE } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { setProviders } from '../lib/settings.ts';
import { runStep, type StepFact } from '../lib/steps.ts';

type Device = { id: number; kind: string; name: string };
type Turn = { id: number; transcript: string | null; outcome: string };

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  const response = await request.get('/api/devices');
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Device[];
}

async function readTurns(request: APIRequestContext, deviceId: number): Promise<Turn[]> {
  const response = await request.get(`/api/turns?limit=10&deviceId=${deviceId}`);
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as Turn[];
}

/** Arms the gateway's one-shot question + listen_for_reply response. */
async function armFollowUp(): Promise<void> {
  await gatewayJson('/scenario', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ follow_up: true }),
  });
}

async function disarmFollowUp(): Promise<void> {
  await gatewayJson('/scenario', { method: 'DELETE' });
}

// The model calls listen_for_reply in the same response as its question; the
// pipeline ends the run with continue_conversation=1 and the Echo opens a new
// run without the wake word. The mock gateway makes that model turn
// deterministic, and the simulator speaks the fixture into the follow-up.
test.describe('Follow-up', { tag: '@integration' }, () => {
  test.skip(OPENAI_MODE !== 'mock', 'the follow-up question needs the deterministic mock model');

  test('A follow-up is answered without the wake word', async ({ page, request }, testInfo) => {
    const steps: StepFact[] = [];
    let failure: unknown;
    try {
      const device = (await listDevices(request)).find((candidate) => candidate.kind === 'echo');
      if (!device) throw new Error('the onboarded Echo is not in /api/devices');
      // OpenAI is always configured (onboarding saves its key); thinking is
      // always OpenAI, so this is the one provider the follow-up needs.
      await setProviders('openai', 'openai');
      const baseline = (await readTurns(request, device.id))[0]?.id ?? 0;
      const before = await echoJson<EchoState>('/state');
      const repliesBefore = before.played.filter((item) => item.kind === 'reply').length;

      await armFollowUp();
      await resetGatewayCalls();

      await runStep(
        testInfo,
        page,
        12,
        'Follow-up answered',
        'follow-up',
        async (capture) => {
          const wake = await echoJson<{ runId: number }>('/wake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fixture: 'what-time-is-it' }),
          });
          // The initial run's done flag only flips once the Echo is idle again,
          // i.e. after the follow-up has been answered too. Two new turns must
          // then exist: the question first, the follow-up second.
          const run = await waitFor<EchoRun>(
            async () => {
              const current = await echoJson<EchoRun>(`/runs/${wake.runId}`);
              return current.done ? current : null;
            },
            { what: 'the question and follow-up runs to finish', timeoutMs: 120_000 },
          );
          expect(run.outcome).toBe('answered');
          expect(run.runEnd).toBe(true);

          const turns = await waitFor<Turn[]>(
            async () => {
              const current = await readTurns(request, device.id);
              const fresh = current.filter((turn) => turn.id > baseline).sort((a, b) => a.id - b.id);
              return fresh.length >= 2 ? fresh : null;
            },
            { what: 'the follow-up turn in the history', timeoutMs: 120_000 },
          );
          const [asked, answered] = turns;
          if (!asked || !answered) throw new Error('expected two new turns');
          expect(asked.outcome).toBe('answered');
          expect(asked.transcript).toBe('What time is it?');
          expect(answered.outcome).toBe('answered');
          expect(answered.transcript).toBe('What time is it?');
          expect(answered.id).toBeGreaterThan(asked.id);

          const after = await echoJson<EchoState>('/state');
          const repliesAfter = after.played.filter((item) => item.kind === 'reply').length;
          expect(repliesAfter - repliesBefore).toBeGreaterThanOrEqual(2);

          const calls = await gatewayJson<OpenAiCall[]>('/calls');
          const responses = calls.filter(
            (call) => call.service === 'openai' && call.path === '/v1/responses' && call.status === 200,
          );
          expect(responses).toHaveLength(2);

          await page.goto('/');
          const latestTurns = page.getByRole('region', { name: 'Latest turns' });
          await expect(latestTurns).toContainText('What time is it?');
          await capture();
        },
        steps,
      );
    } catch (error) {
      failure = error;
    } finally {
      await disarmFollowUp().catch(() => {});
    }

    await collectFacts(steps).catch((error) => {
      failure ??= error;
    });
    if (failure) throw failure;
  });
});
