import { type ApiErrorCode, isApiErrorBody } from '@cortecho/shared';

/** `NETWORK_ERROR` is client-only: the request never reached the server. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR';

/**
 * Thrown by `apiRequest` for every failed request, so components only ever
 * deal with one error type. `fields` maps form field names to messages.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fields: Record<string, string>;

  constructor(status: number, code: ClientErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/**
 * Small `fetch` wrapper for our JSON API.
 * - Paths are relative (`/api/...`): Vite proxies them in dev, Hono serves
 *   them on the same origin in production.
 * - Paths get Vite's `base` prefix, which is empty unless the dev server runs
 *   behind a path-prefixed proxy (see DEV_BASE_PATH in vite.config.ts).
 * - Non-2xx responses become an `ApiError` with the server's code and fields.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  // BASE_URL always ends in '/' and `path` starts with one: drop the duplicate.
  const url = import.meta.env.BASE_URL.replace(/\/$/, '') + path;

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    // fetch only rejects when there is no response at all (offline, DNS, CORS).
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message, body.error.fields);
    }
    throw new ApiError(response.status, 'INTERNAL_ERROR', `Unexpected server response (${response.status}).`);
  }

  return body as T;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
