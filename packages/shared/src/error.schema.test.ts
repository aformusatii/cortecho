import { describe, expect, it } from 'vitest';
import { isApiErrorBody } from './error.schema.ts';

describe('isApiErrorBody', () => {
  it('recognises our error shape', () => {
    expect(isApiErrorBody({ error: { code: 'NOT_FOUND', message: 'User not found' } })).toBe(true);
  });

  it.each([null, 'oops', {}, { error: 'x' }, { error: { code: 1, message: 'x' } }])('rejects %j', (value) => {
    expect(isApiErrorBody(value)).toBe(false);
  });
});
