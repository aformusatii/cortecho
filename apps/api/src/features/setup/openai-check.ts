import type { OpenAiCheckResult } from '@cortecho/shared';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * "Check and continue" (spec §7.6): list the models with the given key against
 * the configured base URL. It proves the key works without spending anything
 * on speech or tokens.
 *
 * The key only ever travels in the Authorization header. It is never logged,
 * never put in the result and never read back from a response body.
 */
export async function checkOpenAiKey({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: {
  apiKey: string;
  /** Config's OPENAI_BASE_URL (a proxy or a test server); undefined = OpenAI. */
  baseUrl: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OpenAiCheckResult> {
  const key = apiKey.trim();
  // The route refuses a missing key before calling here; a blank key can only
  // mean a bug, and OpenAI would answer 401 anyway.
  if (key === '') return { ok: false, code: 'rejected' };

  try {
    const response = await fetchImpl(`${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is not needed, and not reading it keeps it out of logs.
    void response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true };
    // OpenAI answered and refused the key; anything else means we never got a
    // usable answer from it.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'rejected' };
    }
    return { ok: false, code: 'unreachable' };
  } catch {
    // Offline, DNS, a timeout (AbortError), a TLS error: no answer at all.
    return { ok: false, code: 'unreachable' };
  }
}
