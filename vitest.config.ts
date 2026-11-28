import { defineConfig } from 'vitest/config';

// One `npm test` runs the unit tests of every workspace that has them.
// The web app is covered by Playwright (e2e/), not by Vitest.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './packages/shared', include: ['src/**/*.test.ts'] } },
      { test: { name: 'api', root: './apps/api', include: ['src/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'onboarding',
          root: './onboarding',
          include: ['runner/**/*.test.ts'],
          environment: 'node',
        },
      },
      // Plain-Node scripts run by the workflows: versioning and ghcr cleanup.
      { test: { name: 'scripts', root: './scripts', include: ['*.test.mjs'], environment: 'node' } },
    ],
  },
});
