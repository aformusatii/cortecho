import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The SMOKE_* variables, read from `smoke/.env.smoke` and validated with Zod.
 * The file is gitignored; `.env.smoke.example` documents every variable.
 */

const SMOKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const SMOKE_ENV_PATH = path.join(SMOKE_DIR, '.env.smoke');

/** "1"/"true"/"yes"/"on" are true; anything else (or absent) is false. */
const boolFlag = z.preprocess(
  (value) => value === '1' || value === 'true' || value === 'yes' || value === 'on' || value === true,
  z.boolean(),
);

/** Trimmed string; an empty value reads as undefined (optional variables). */
const optionalStr = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined),
  z.string().optional(),
);

const EnvSchema = z.object({
  // Cortecho
  SMOKE_CORTECHO_URL: z.string().default('http://192.168.100.3:8063'),
  SMOKE_CORTECHO_CONTAINER: z.string().default('cortecho'),

  // The suite's own OpenAI key
  SMOKE_OPENAI_API_KEY: z.string().min(1, 'SMOKE_OPENAI_API_KEY is required'),
  SMOKE_OPENAI_BASE_URL: optionalStr,

  // The owner's simulated voice
  SMOKE_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  SMOKE_TTS_VOICE: z.string().default('nova'),
  SMOKE_TTS_INSTRUCTIONS: optionalStr,
  SMOKE_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),

  // The simulated Echo's identity
  SMOKE_ECHO_BIND: z.string().default('0.0.0.0'),
  SMOKE_ECHO_HOST: z.string().default('code-server'),
  SMOKE_ECHO_PORT: z.coerce.number().int().min(1).max(65535).default(26099),
  SMOKE_ECHO_API_KEY: z.string().min(1, 'SMOKE_ECHO_API_KEY is required'),
  SMOKE_ECHO_NODE_NAME: z.string().min(1).default('echo-dot-2-smoke'),
  SMOKE_ECHO_MAC: z.string().min(1).default('02:00:00:00:00:02'),
  SMOKE_ECHO_WAKE_WORD: z.string().default('Computer'),
  SMOKE_DEVICE_NAME: z.string().default('Test Echo'),
  SMOKE_MIRROR_DEVICE: optionalStr,

  // Mic levels
  SMOKE_SPEECH_DBFS: z.coerce.number().default(-26),
  SMOKE_ROOM_DBFS: z.coerce.number().default(-60),

  // Guards
  SMOKE_MAX_TURNS: z.coerce.number().int().min(1).default(20),
  SMOKE_YES: boolFlag.default(false),
  SMOKE_FORCE: boolFlag.default(false),
});

export type SmokeEnv = z.infer<typeof EnvSchema>;

export class SmokeEnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`smoke/.env.smoke is missing or invalid: ${missing.join(', ')}`);
    this.name = 'SmokeEnvError';
    this.missing = missing;
  }
}

/**
 * Loads and validates the smoke configuration. Throws SmokeEnvError when the
 * file is absent or a required variable is missing, so the suite refuses to
 * start rather than half-run against production.
 */
export function loadEnv(): SmokeEnv {
  if (!existsSync(SMOKE_ENV_PATH)) {
    throw new SmokeEnvError(['no smoke/.env.smoke (run `npm run smoke:init`)']);
  }
  process.loadEnvFile(SMOKE_ENV_PATH);
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new SmokeEnvError(missing);
  }
  return result.data;
}
