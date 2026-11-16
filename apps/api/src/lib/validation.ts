import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';
import { validationError } from './errors.ts';

/**
 * Turns Zod issues into `{ fieldName: firstMessage }`, the shape the web form
 * needs to show each message under its input. Nested paths use dots.
 */
export function issuesToFields(issues: z.core.$ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    // Keep the first message per field; later ones are usually consequences.
    fields[key] ??= issue.message;
  }
  return fields;
}

/**
 * `zValidator` with our error format. Use it instead of `zValidator` directly
 * so every route answers invalid input with the same 400 body.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw validationError(issuesToFields(result.error.issues));
    }
  });
}
