import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path of the repository root (apps/api/src -> ../../..).
// Relative paths in env vars are resolved from here, so `npm run db:migrate`
// and `npm run dev` find the same ./data/app.db regardless of the cwd npm uses.
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const NODE_ENVS = ['development', 'production', 'test'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

function readNodeEnv(): NodeEnv {
  const value = process.env.NODE_ENV ?? 'development';
  if (!(NODE_ENVS as readonly string[]).includes(value)) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVS.join(', ')} (got "${value}")`);
  }
  return value as NodeEnv;
}

function readPort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

/** Validated configuration. Read once at startup; fail fast on bad values. */
export const env = {
  NODE_ENV: readNodeEnv(),
  // 0.0.0.0 = every network interface, so other machines (and Docker's port
  // mapping) can connect. Set HOST=127.0.0.1 to allow this machine only.
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: readPort(),
  DATABASE_PATH: path.resolve(REPO_ROOT, process.env.DATABASE_PATH ?? './data/app.db'),
} as const;

export const isProduction = env.NODE_ENV === 'production';
