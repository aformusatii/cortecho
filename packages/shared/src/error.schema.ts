/**
 * Every API error has this shape, whatever the status code:
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": { "text": "..." } } }
 * `fields` is only present when the error belongs to specific form fields,
 * so the web form can show the message inline under the right input.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  // The Echo is not connected, or it is in the middle of a voice turn.
  'ECHO_UNAVAILABLE',
  'ECHO_BUSY',
  // Adding an Echo (spec §7.3/§7.4): nothing answered, or the device is not a voice Echo.
  'ECHO_UNREACHABLE',
  'NOT_AN_ECHO',
  // An Echo that already has a key (another app, or Cortecho with a lost row).
  'ECHO_KEY_SET',
  'ECHO_KEY_INVALID',
  // The address or the MAC is already a device.
  'ALREADY_ADDED',
  // Securing the link failed; nothing was changed on the Echo.
  'ADOPT_FAILED',
  // OpenAI failed or is not configured (no OPENAI_API_KEY).
  'UPSTREAM_ERROR',
  // A settings PATCH carried a stale version (another tab saved first).
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
  };
};

/** Type guard used by the web client to recognise our error shape. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}
