import type { ApiErrorBody, ApiErrorCode } from '@cortecho/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An error we throw on purpose. `app.onError` turns it into the standard
 * `{ error: { code, message, fields? } }` JSON body with the given status.
 * Anything else that is thrown becomes a generic 500.
 */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string> | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export function validationError(fields: Record<string, string>): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'The request contains invalid values.', fields);
}
