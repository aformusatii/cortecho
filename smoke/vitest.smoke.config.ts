import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The production smoke suite (spec §3.1): one worker, no isolation, long
// timeouts. It needs keys, the production deployment and money, so it is never
// part of `npm test` or CI — run it deliberately with `npm run test:smoke`.
export default defineConfig({
  test: {
    name: 'smoke',
    // The smoke folder itself, whatever the working directory (npm runs from the repo root).
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['scenarios/**/*.smoke.ts'],
    globalSetup: ['./globalSetup.ts'],
    setupFiles: ['./harness/matchers.ts'],
    // One worker, files in sequence, shared module registry: the SmokeEcho
    // singleton lives across files (spec §6.1).
    fileParallelism: false,
    maxWorkers: 1,
    isolate: false,
    sequence: { concurrent: false },
    // A turn (wake → reply → playback) can take tens of seconds.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});
