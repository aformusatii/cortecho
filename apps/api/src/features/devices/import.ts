import { parseApiKey } from '../../esphome/noise.ts';
import { createLogger } from '../../lib/logger.ts';
import type { Device, DevicesRepository } from './devices.repository.ts';

const log = createLogger('devices');

/**
 * One-time import of the one Echo from the old environment (spec §12):
 * if the devices table is empty and ECHO_HOST is set, create "Echo".
 * After it, ECHO_* are ignored by the gateway (a warning lists them); they
 * stay only for `echo-set-key`, which reads its own environment.
 */
export function importDeviceFromEnvironment(
  repository: DevicesRepository,
  env: NodeJS.ProcessEnv = process.env,
): Device | null {
  if (repository.count() > 0) return null;
  const host = env.ECHO_HOST?.trim();
  if (!host) return null;
  const port = Number(env.ECHO_PORT?.trim() || 26053);
  let apiKey: string | null = env.ECHO_API_KEY?.trim() || null;
  if (apiKey) {
    try {
      parseApiKey(apiKey);
    } catch {
      log.warn('ECHO_API_KEY is not a base64 32-byte key; importing the device as a plaintext link');
      apiKey = null;
    }
  }
  try {
    const device = repository.create({
      name: 'Echo',
      kind: 'echo',
      host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 26053,
      apiKey,
      enabled: true,
      prompt: '',
    });
    log.info(
      `imported the Echo from the environment as device #${device.id} (${device.host}:${device.port})`,
    );
    return device;
  } catch (error) {
    // A duplicate (name or host:port) means it was imported before: not an error at start.
    log.warn(`could not import the Echo from the environment: ${(error as Error).message}`);
    return null;
  }
}

/** Warns once at start that ECHO_* no longer drive the gateway. */
export function warnStaleDeviceEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const stillSet = ['ECHO_HOST', 'ECHO_PORT', 'ECHO_API_KEY'].filter(
    (name) => (env[name] ?? '').trim() !== '',
  );
  if (stillSet.length > 0) {
    log.warn(
      `these environment variables are ignored now (the Echoes are devices in the database): ${stillSet.join(', ')}`,
    );
  }
}
