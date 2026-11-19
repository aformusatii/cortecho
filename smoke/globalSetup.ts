import { CortechoApi } from './harness/cortecho-api.ts';
import { loadEnv } from './harness/env.ts';

/**
 * The safety net (spec §6.3). Runs outside the test process, so it cannot hold
 * the in-process simulator; at exit (and on Ctrl-C) it sends a plain, idempotent
 * `PATCH enabled: false` over HTTP, so a crashed run does not leave the Test
 * Echo connected. A disabled device with no link looks to Cortecho like a real
 * Echo that was switched off.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch {
    // No configuration: nothing to disable.
    return async () => {};
  }
  const api = new CortechoApi(env.SMOKE_CORTECHO_URL);

  const disable = async (): Promise<void> => {
    try {
      const devices = await api.listDevices();
      const device = devices.find(
        (candidate) => candidate.host === env.SMOKE_ECHO_HOST && candidate.port === env.SMOKE_ECHO_PORT,
      );
      if (device) await api.patchDevice(device.id, { enabled: false });
    } catch (error) {
      console.error(`smoke: teardown could not disable the Test Echo: ${String(error)}`);
    }
  };

  // Vitest does not guarantee hooks on Ctrl-C, so disable on the signals too.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void disable();
    });
  }

  return disable;
}
