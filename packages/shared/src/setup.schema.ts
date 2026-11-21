import { z } from 'zod';

// ---------------------------------------------------------------------------
// The setup wizard's HTTP contract (features/setup/setup.routes.ts, spec
// §7.6). The key itself is write-only: no response here ever carries it, only
// `hasOpenAiKey`.
// ---------------------------------------------------------------------------

/**
 * GET /api/setup, and the answer of POST/DELETE /api/setup/complete: what the
 * redirect and the onboarding's skip logic need, and nothing more.
 */
export const setupDocumentSchema = z.object({
  /** `onboarding.completedAt` is recorded in app_state. */
  onboardingDone: z.boolean(),
  /** At least one device of kind `echo` exists, enabled or not (spec §8.3). */
  hasEcho: z.boolean(),
  hasOpenAiKey: z.boolean(),
  /** The saved reply address, trimmed; null when it is empty or unset. */
  replyBaseUrl: z.string().nullable(),
  /**
   * The owner already changed the time zone or the language: the settings
   * history has a row for the key (so the Home step can be skipped).
   */
  homeConfirmed: z.boolean(),
});
export type SetupDocument = z.infer<typeof setupDocumentSchema>;

/** POST /api/setup/check-openai: absent means "check the stored key". */
export const setupCheckOpenAiSchema = z.object({
  apiKey: z.string().trim().max(400).optional(),
});
export type SetupCheckOpenAi = z.infer<typeof setupCheckOpenAiSchema>;

/**
 * `rejected`  OpenAI answered, and refused the key (401/403).
 * `unreachable` no usable answer: network, timeout or a server error.
 */
export const OPENAI_CHECK_CODES = ['rejected', 'unreachable'] as const;
export type OpenAiCheckCode = (typeof OPENAI_CHECK_CODES)[number];
export type OpenAiCheckResult = { ok: true } | { ok: false; code: OpenAiCheckCode };

/**
 * §8.3: onboarding shows only when it was never finished AND no Echo of kind
 * `echo` exists, so an existing install never sees it.
 */
export function isFirstLaunch(doc: Pick<SetupDocument, 'onboardingDone' | 'hasEcho'>): boolean {
  return !doc.onboardingDone && !doc.hasEcho;
}
