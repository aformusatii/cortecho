import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

/**
 * Noise_NNpsk0_25519_ChaChaPoly_SHA256, the handshake of ESPHome's API
 * encryption (Noise spec rev 34, as hassmic's noise.c implements it):
 *
 *   -> psk, e
 *   <- e, ee
 *
 * With the PSK set to the device's 32-byte API key, only a client that knows
 * the key completes the handshake. Everything comes from node:crypto (X25519,
 * ChaCha20-Poly1305, SHA-256), so there is no crypto dependency.
 *
 * Both roles are here: the client uses the initiator, the fake Echo in the
 * tests the responder.
 */

const PROTOCOL = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
/** ESPHome's prologue: "NoiseAPIInit" plus two zero bytes. */
export const ESPHOME_PROLOGUE = Buffer.from('NoiseAPIInit\0\0', 'latin1');
export const NOISE_TAG_BYTES = 16;
const DH_BYTES = 32;
/** DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const EMPTY = Buffer.alloc(0);

export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseError';
  }
}

const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const hmac = (key: Buffer, ...parts: Buffer[]) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** HKDF as Noise defines it, two or three 32-byte outputs. */
function hkdf(ck: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, o1, Buffer.from([2]));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmac(temp, o2, Buffer.from([3]))];
}

function nonce(n: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(BigInt(n), 4);
  return out;
}

function aeadEncrypt(key: Buffer, n: number, ad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: NOISE_TAG_BYTES });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aeadDecrypt(key: Buffer, n: number, ad: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < NOISE_TAG_BYTES) throw new NoiseError('ciphertext shorter than its tag');
  const body = ciphertext.subarray(0, ciphertext.length - NOISE_TAG_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce(n), { authTagLength: NOISE_TAG_BYTES });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - NOISE_TAG_BYTES));
  decipher.setAAD(ad, { plaintextLength: body.length });
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new NoiseError('message failed authentication (wrong key?)');
  }
}

/** One direction of the transport: a key and a message counter. */
export class CipherState {
  private readonly key: Buffer;
  private n = 0;

  constructor(key: Buffer) {
    this.key = key;
  }

  encrypt(plaintext: Buffer): Buffer {
    return aeadEncrypt(this.key, this.n++, EMPTY, plaintext);
  }

  /** The counter only advances on success, like hassmic's noise_decrypt. */
  decrypt(ciphertext: Buffer): Buffer {
    const out = aeadDecrypt(this.key, this.n, EMPTY, ciphertext);
    this.n++;
    return out;
  }
}

type KeyPair = { privateKey: KeyObject; publicKey: Buffer };

function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(der.subarray(der.length - DH_BYTES)) };
}

function dh(privateKey: KeyObject, remotePublic: Buffer): Buffer {
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, remotePublic]),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey, publicKey });
}

/** Noise's SymmetricState: the running hash h, chaining key ck and handshake key k. */
class SymmetricState {
  h: Buffer;
  private ck: Buffer;
  private k: Buffer | null = null;
  private n = 0;

  constructor(prologue: Buffer) {
    const name = Buffer.from(PROTOCOL, 'ascii');
    // A name longer than the hash length is hashed (this one is 36 bytes).
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.ck = this.h;
    this.mixHash(prologue);
  }

  mixHash(data: Buffer): void {
    this.h = sha256(this.h, data);
  }

  mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Buffer, Buffer];
    this.ck = ck;
    this.k = k;
    this.n = 0;
  }

  mixKeyAndHash(ikm: Buffer): void {
    const [ck, th, k] = hkdf(this.ck, ikm, 3) as [Buffer, Buffer, Buffer];
    this.ck = ck;
    this.mixHash(th);
    this.k = k;
    this.n = 0;
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const out = this.k ? aeadEncrypt(this.k, this.n++, this.h, plaintext) : plaintext;
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const out = this.k ? aeadDecrypt(this.k, this.n++, this.h, ciphertext) : ciphertext;
    this.mixHash(ciphertext);
    return out;
  }

  /** The initiator sends with the first key. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2) as [Buffer, Buffer];
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export type Transport = { send: CipherState; receive: CipherState };

function checkPsk(psk: Buffer): void {
  if (psk.length !== 32) throw new NoiseError(`the PSK must be 32 bytes (got ${psk.length})`);
}

/** The client's side: write message 1, read message 2, get the transport keys. */
export class NoiseInitiator {
  private readonly ss = new SymmetricState(ESPHOME_PROLOGUE);
  private readonly psk: Buffer;
  private e: KeyPair | null = null;

  constructor(psk: Buffer) {
    checkPsk(psk);
    this.psk = psk;
  }

  writeMessage1(payload: Buffer = EMPTY): Buffer {
    this.ss.mixKeyAndHash(this.psk); // psk
    this.e = generateKeyPair(); // e (in psk mode also MixKey)
    this.ss.mixHash(this.e.publicKey);
    this.ss.mixKey(this.e.publicKey);
    return Buffer.concat([this.e.publicKey, this.ss.encryptAndHash(payload)]);
  }

  readMessage2(message: Buffer): { payload: Buffer; transport: Transport } {
    if (!this.e) throw new NoiseError('message 1 was not written');
    if (message.length < DH_BYTES + NOISE_TAG_BYTES) throw new NoiseError('handshake message 2 is too short');
    const re = message.subarray(0, DH_BYTES);
    this.ss.mixHash(re); // e
    this.ss.mixKey(re);
    this.ss.mixKey(dh(this.e.privateKey, re)); // ee
    const payload = this.ss.decryptAndHash(message.subarray(DH_BYTES));
    const [c1, c2] = this.ss.split();
    return { payload, transport: { send: c1, receive: c2 } };
  }
}

/** The Echo's side (fake Echo only). */
export class NoiseResponder {
  private readonly ss = new SymmetricState(ESPHOME_PROLOGUE);
  private readonly psk: Buffer;
  private re: Buffer | null = null;

  constructor(psk: Buffer) {
    checkPsk(psk);
    this.psk = psk;
  }

  /** Throws NoiseError when the initiator used another PSK. */
  readMessage1(message: Buffer): Buffer {
    if (message.length < DH_BYTES + NOISE_TAG_BYTES) throw new NoiseError('handshake message 1 is too short');
    this.ss.mixKeyAndHash(this.psk);
    this.re = Buffer.from(message.subarray(0, DH_BYTES));
    this.ss.mixHash(this.re);
    this.ss.mixKey(this.re);
    return this.ss.decryptAndHash(message.subarray(DH_BYTES));
  }

  writeMessage2(payload: Buffer = EMPTY): { message: Buffer; transport: Transport } {
    if (!this.re) throw new NoiseError('message 1 was not read');
    const e = generateKeyPair();
    this.ss.mixHash(e.publicKey);
    this.ss.mixKey(e.publicKey);
    this.ss.mixKey(dh(e.privateKey, this.re));
    const message = Buffer.concat([e.publicKey, this.ss.encryptAndHash(payload)]);
    const [c1, c2] = this.ss.split();
    return { message, transport: { send: c2, receive: c1 } };
  }
}

/** ECHO_API_KEY: base64 of 32 bytes, as Home Assistant and hassmic store it. */
export function parseApiKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64.trim()) {
    throw new NoiseError('ECHO_API_KEY must be the base64 encoding of exactly 32 bytes');
  }
  return key;
}
