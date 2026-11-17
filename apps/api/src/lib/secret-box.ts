import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypted-at-rest values for connector secrets (OAuth tokens, client
 * secrets, header values). The key lives outside the database
 * (CORTECHO_SECRET_KEY), so a leaked backup cannot read the owner's mail.
 *
 * Format: `v1:<iv base64>:<ciphertext+tag base64>` (AES-256-GCM, 12-byte IV,
 * 16-byte authentication tag). A wrong key or a tampered value throws; callers
 * treat that as "sign in again", never as a crash.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** Decodes CORTECHO_SECRET_KEY (base64 of exactly 32 bytes). */
export function parseSecretKey(raw: string | undefined | null): Buffer | null {
  if (!raw || raw.trim() === '') return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new SecretBoxError('CORTECHO_SECRET_KEY is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(`CORTECHO_SECRET_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`);
  }
  return key;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new SecretBoxError(`The key must be ${KEY_BYTES} bytes.`);
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('base64')}:${Buffer.concat([ciphertext, tag]).toString('base64')}`;
  }

  decrypt(value: string): string {
    const parts = value.split(':');
    if (parts.length !== 3 || parts[0] !== VERSION) throw new SecretBoxError('Unknown secret format.');
    const iv = Buffer.from(parts[1] ?? '', 'base64');
    const payload = Buffer.from(parts[2] ?? '', 'base64');
    if (iv.length !== IV_BYTES || payload.length < 16) throw new SecretBoxError('The secret is malformed.');
    const ciphertext = payload.subarray(0, payload.length - 16);
    const tag = payload.subarray(payload.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key or a tampered tag. Never include the value in the error.
      throw new SecretBoxError(
        'The secret cannot be decrypted (wrong CORTECHO_SECRET_KEY or tampered data).',
      );
    }
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(value: string): T {
    try {
      return JSON.parse(this.decrypt(value)) as T;
    } catch (error) {
      if (error instanceof SecretBoxError) throw error;
      throw new SecretBoxError('The decrypted value is not valid JSON.');
    }
  }
}

/** `null` when the key is missing: connectors then accept `auth_type: none` only. */
export function createSecretBox(raw: string | undefined | null): SecretBox | null {
  const key = parseSecretKey(raw);
  return key ? new SecretBox(key) : null;
}
