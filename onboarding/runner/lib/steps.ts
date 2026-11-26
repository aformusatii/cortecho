import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Page, type TestInfo, test } from '@playwright/test';
import { STEPS_DIR } from './env.ts';

export type StepFact = {
  n: number;
  title: string;
  spec: string;
  status: 'passed' | 'failed';
  durationMs: number;
  screenshot: string;
};

/**
 * Runs one user-visible step, attaches its screenshot to that step (so the
 * HTML report shows it inline) and records the timing for summary.md. The body
 * may call `capture` at the moment that best represents the step; otherwise
 * the screenshot is taken when the body ends (or throws).
 */
export async function runStep(
  testInfo: TestInfo,
  page: Page,
  n: number,
  title: string,
  slug: string,
  body: (capture: () => Promise<void>) => Promise<void>,
  steps: StepFact[],
): Promise<void> {
  mkdirSync(STEPS_DIR, { recursive: true });
  const number = String(n).padStart(2, '0');
  const relative = `steps/${number}-${slug}.png`;
  const absolute = path.join(STEPS_DIR, `${number}-${slug}.png`);
  const startedAt = Date.now();
  let captured = false;
  let status: StepFact['status'] = 'passed';

  async function capture(): Promise<void> {
    if (captured) return;
    captured = true;
    try {
      await page.screenshot({ path: absolute, fullPage: false, animations: 'disabled' });
      await testInfo.attach(`${number} ${title}`, { path: absolute, contentType: 'image/png' });
    } catch {
      // A screenshot must not hide the test's own failure.
    }
  }

  try {
    await test.step(`${number} · ${title}`, async () => {
      try {
        await body(capture);
      } catch (error) {
        status = 'failed';
        await capture();
        throw error;
      } finally {
        await capture();
      }
    });
  } finally {
    steps.push({
      n,
      title,
      spec: path.basename(testInfo.file),
      status,
      durationMs: Date.now() - startedAt,
      screenshot: relative,
    });
  }
}
