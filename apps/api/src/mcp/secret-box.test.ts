import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, parseSecretKey, SecretBoxError } from '../lib/secret-box.ts';

const KEY = randomBytes(32);
const OTHER = randomBytes(32);

describe('secret-box', () => {
  it('round-trips a value and JSON', () => {
    const box = createSecretBox(KEY.toString('base64'));
    expect(box).not.toBeNull();
    const value = box?.encrypt('hello world');
    expect(value).toMatch(/^v1:[^:]+:[^:]+$/);
    expect(box?.decrypt(value as string)).toBe('hello world');
    const json = box?.encryptJson({ access_token: 'abc', expires_at: 1 }) as string;
    expect(box?.decryptJson(json)).toEqual({ access_token: 'abc', expires_at: 1 });
  });

  it('refuses a wrong key and a tampered tag', () => {
    const box = createSecretBox(KEY.toString('base64'));
    const other = createSecretBox(OTHER.toString('base64'));
    const value = box?.encrypt('mail token') as string;
    expect(() => other?.decrypt(value)).toThrow(SecretBoxError);
    const parts = value.split(':');
    const payload = Buffer.from(parts[2] as string, 'base64');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${payload.toString('base64')}`;
    expect(() => box?.decrypt(tampered)).toThrow(/cannot be decrypted/);
  });

  it('checks the key length and format', () => {
    expect(parseSecretKey('')).toBeNull();
    expect(parseSecretKey(undefined)).toBeNull();
    expect(() => parseSecretKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(parseSecretKey(KEY.toString('base64'))).toHaveLength(32);
  });
});
