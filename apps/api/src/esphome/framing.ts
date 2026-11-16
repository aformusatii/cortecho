import type { CipherState } from './noise.ts';
import { encodeVarint, readVarint } from './protobuf.ts';

/**
 * The two ways ESPHome frames messages on the TCP stream (hassmic's `serve`
 * and `send_to`):
 *
 *   plaintext  0x00, varint length, varint type, message
 *   noise      0x01, big-endian u16 length, frame body; after the handshake
 *              the body is encrypted [u16 type, u16 length, message]
 *
 * hassmic refuses plaintext messages over 1 MiB, and drops encrypted ones it
 * sends over 8 KiB (so all our messages stay small; mic audio comes in 4 KiB
 * pieces).
 */

export const MAX_PLAINTEXT_MESSAGE = 1 << 20;
export const MAX_NOISE_FRAME = 0xffff;

export type ApiMessage = { type: number; payload: Buffer };

/** Raised when a plaintext connection gets a Noise frame: the Echo has an API key set. */
export class EncryptionRequiredError extends Error {
  constructor() {
    super('the Echo requires encryption (an API key is set on it)');
    this.name = 'EncryptionRequiredError';
  }
}

/** Raised when an encrypted connection gets a plaintext frame: the Echo has no key, or speaks plaintext only. */
export class PlaintextOnlyError extends Error {
  constructor() {
    super('the Echo answered in plaintext: it has no API key set');
    this.name = 'PlaintextOnlyError';
  }
}

export function encodePlaintext(type: number, payload: Buffer): Buffer {
  if (payload.length > MAX_PLAINTEXT_MESSAGE)
    throw new Error(`message ${type} is too long (${payload.length})`);
  return Buffer.concat([Buffer.from([0]), encodeVarint(payload.length), encodeVarint(type), payload]);
}

export function encodeNoiseFrame(body: Buffer): Buffer {
  if (body.length > MAX_NOISE_FRAME) throw new Error(`noise frame too long (${body.length})`);
  const header = Buffer.from([1, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

/** Incremental reader for plaintext frames. */
export class PlaintextReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): ApiMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: ApiMessage[] = [];
    for (;;) {
      if (this.buffer.length === 0) break;
      const indicator = this.buffer[0];
      if (indicator === 1) throw new EncryptionRequiredError();
      if (indicator !== 0) throw new Error(`bad frame indicator 0x${(indicator ?? 0).toString(16)}`);
      const len = readVarint(this.buffer, 1);
      if (!len) break;
      if (len.value > MAX_PLAINTEXT_MESSAGE)
        throw new Error(`message of ${len.value} bytes is over the limit`);
      const type = readVarint(this.buffer, len.next);
      if (!type) break;
      const end = type.next + len.value;
      if (this.buffer.length < end) break;
      out.push({ type: type.value, payload: Buffer.from(this.buffer.subarray(type.next, end)) });
      this.buffer = this.buffer.subarray(end);
    }
    return out;
  }
}

/** Incremental reader for Noise frames (handshake and transport). Returns the frame bodies. */
export class NoiseFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    while (this.buffer.length >= 3) {
      const indicator = this.buffer[0];
      if (indicator === 0) throw new PlaintextOnlyError();
      if (indicator !== 1) throw new Error(`bad noise frame indicator 0x${(indicator ?? 0).toString(16)}`);
      const len = ((this.buffer[1] ?? 0) << 8) | (this.buffer[2] ?? 0);
      if (this.buffer.length < 3 + len) break;
      out.push(Buffer.from(this.buffer.subarray(3, 3 + len)));
      this.buffer = this.buffer.subarray(3 + len);
    }
    return out;
  }

  /** Bytes received after the last whole frame (handed on when the handshake ends). */
  takeRest(): Buffer {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

/** Encrypts/decrypts whole messages once the Noise handshake is done. */
export class NoiseTransportCodec {
  private readonly reader = new NoiseFrameReader();
  private readonly send: CipherState;
  private readonly receive: CipherState;

  constructor(send: CipherState, receive: CipherState) {
    this.send = send;
    this.receive = receive;
  }

  encode(type: number, payload: Buffer): Buffer {
    const plain = Buffer.alloc(4 + payload.length);
    plain.writeUInt16BE(type, 0);
    plain.writeUInt16BE(payload.length, 2);
    payload.copy(plain, 4);
    return encodeNoiseFrame(this.send.encrypt(plain));
  }

  push(chunk: Buffer): ApiMessage[] {
    return this.reader.push(chunk).map((frame) => this.decodeFrame(frame));
  }

  /** One frame body that was already cut out of the stream (the handshake reader hands these over). */
  decodeFrame(frame: Buffer): ApiMessage {
    const plain = this.receive.decrypt(frame);
    if (plain.length < 4) throw new Error('encrypted frame shorter than its header');
    const type = plain.readUInt16BE(0);
    const len = plain.readUInt16BE(2);
    if (len !== plain.length - 4)
      throw new Error(`encrypted frame length mismatch (${len} vs ${plain.length - 4})`);
    return { type, payload: Buffer.from(plain.subarray(4)) };
  }
}

/** Same interface for the plaintext side. */
export class PlaintextCodec {
  private readonly reader = new PlaintextReader();

  encode(type: number, payload: Buffer): Buffer {
    return encodePlaintext(type, payload);
  }

  push(chunk: Buffer): ApiMessage[] {
    return this.reader.push(chunk);
  }
}

export type MessageCodec = {
  encode(type: number, payload: Buffer): Buffer;
  push(chunk: Buffer): ApiMessage[];
};
