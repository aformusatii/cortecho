import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL ?? 'http://10.231.47.10:3000';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // A real voice turn takes seconds; adoption and reconnects take tens more.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  outputDir: process.env.ONBOARDING_OUTPUT_DIR ?? '/out/artifacts',
  reporter: [['blob'], ['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 1280, height: 800 },
    video: 'on',
    trace: 'on',
    screenshot: 'on',
    serviceWorkers: 'block',
  },
});
