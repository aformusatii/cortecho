import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;
// A separate, fresh database so e2e tests never touch the development data.
// No ECHO_HOST (ESPHome client off) and no OpenAI key: the UI must work
// without either, and the tests never spend API credits.
const E2E_ENV = `DATABASE_PATH=./data/e2e.db PORT=${PORT} ECHO_HOST= OPENAI_API_KEY=`;

export default defineConfig({
  testDir: '.',
  // Tests share one database, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // The service worker is tested on purpose in pwa.spec.ts; elsewhere it is
    // blocked so cached files can never hide a real failure.
    serviceWorkers: 'block',
  },
  // The key flows run at all three required widths.
  // The PWA checks do not depend on the width, so they run once (desktop).
  projects: [
    {
      name: 'mobile',
      testIgnore: /pwa\.spec/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true },
    },
    {
      name: 'tablet',
      testIgnore: /pwa\.spec/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],
  // Tests run against the PRODUCTION build: the same single-port server,
  // static files and service worker that Docker ships. Two FakeEchos listen
  // on localhost so device flows (add, connect, say) run without hardware.
  webServer: [
    {
      command: `npm run build && rm -f data/e2e.db* && ${E2E_ENV} NODE_ENV=production node apps/api/src/server.ts`,
      cwd: '..',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node fake-echo-server.ts',
      cwd: '.',
      port: 26101,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
