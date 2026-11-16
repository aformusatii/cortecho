/**
 * The small slice of protobuf the ESPHome native API needs: varints, bools,
 * strings/bytes, fixed32 and floats, plus nested messages. Hand-written
 * instead of a generated codec because we use about a dozen messages with a
 * handful of fields each, and hassmic writes them by hand the same way
 * (proto_esphome.c `pb_*`).
 *
 * proto3 rules that matter here: a field with its zero value is simply not
 * written, and readers treat a missing field as zero / false / "".
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/** Appends fields in order; `finish()` returns the encoded message. */
export class ProtoWriter {
  private readonly parts: Buffer[] = [];

  private key(field: number, wire: number): void {
    this.parts.push(encodeVarint(field * 8 + wire));
  }

  uint(field: number, value: number): this {
    if (!Number.isInteger(value) || value < 0) throw new Error(`field ${field}: ${value} is not a uint`);
    if (value === 0) return this;
    this.key(field, WIRE_VARINT);
    this.parts.push(encodeVarint(value));
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.uint(field, value ? 1 : 0);
  }

  bytes(field: number, value: Buffer): this {
    if (value.length === 0) return this;
    this.key(field, WIRE_LEN);
    this.parts.push(encodeVarint(value.length), value);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, 'utf8'));
  }

  /** A nested message, written even when it is empty (it is "present"). */
  message(field: number, value: Buffer): this {
    this.key(field, WIRE_LEN);
    this.parts.push(encodeVarint(value.length), value);
    return this;
  }

  fixed32(field: number, value: number): this {
    this.key(field, WIRE_FIXED32);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    this.parts.push(b);
    return this;
  }

  float(field: number, value: number): this {
    if (value === 0) return this;
    this.key(field, WIRE_FIXED32);
    const b = Buffer.alloc(4);
    b.writeFloatLE(value);
    this.parts.push(b);
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export type ProtoField =
  | { field: number; wire: typeof WIRE_VARINT; value: number }
  | { field: number; wire: typeof WIRE_FIXED64; value: Buffer }
  | { field: number; wire: typeof WIRE_LEN; value: Buffer }
  | { field: number; wire: typeof WIRE_FIXED32; value: Buffer };

/** Decoded fields of one message, with typed getters (last value wins, like protobuf). */
export class ProtoMessage {
  readonly fields: ProtoField[];

  constructor(data: Buffer) {
    this.fields = decodeFields(data);
  }

  private last(field: number): ProtoField | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (f && f.field === field) return f;
    }
    return undefined;
  }

  uint(field: number): number {
    const f = this.last(field);
    return f?.wire === WIRE_VARINT ? f.value : 0;
  }

  bool(field: number): boolean {
    return this.uint(field) !== 0;
  }

  bytes(field: number): Buffer {
    const f = this.last(field);
    return f?.wire === WIRE_LEN ? f.value : Buffer.alloc(0);
  }

  string(field: number): string {
    return this.bytes(field).toString('utf8');
  }

  has(field: number): boolean {
    return this.last(field) !== undefined;
  }

  fixed32(field: number): number {
    const f = this.last(field);
    return f?.wire === WIRE_FIXED32 ? f.value.readUInt32LE(0) : 0;
  }

  float(field: number): number {
    const f = this.last(field);
    return f?.wire === WIRE_FIXED32 ? f.value.readFloatLE(0) : 0;
  }

  /** Every value of a repeated length-delimited field (strings, nested messages). */
  repeated(field: number): Buffer[] {
    return this.fields.filter((f) => f.field === field && f.wire === WIRE_LEN).map((f) => f.value as Buffer);
  }
}

export function encodeVarint(value: number): Buffer {
  // Numbers here stay far below 2^53; plain arithmetic keeps it exact past 2^32.
  const out: number[] = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

/**
 * Reads a varint at `offset`. Returns null when the buffer ends inside it
 * (the stream parsers wait for more bytes then).
 */
export function readVarint(data: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = offset; i < data.length && i < offset + 10; i++) {
    const byte = data[i] ?? 0;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    scale *= 128;
  }
  if (data.length - offset >= 10) throw new Error('varint longer than 10 bytes');
  return null;
}

function decodeFields(data: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const key = readVarint(data, offset);
    if (!key) throw new Error('truncated field key');
    offset = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    switch (wire) {
      case WIRE_VARINT: {
        const v = readVarint(data, offset);
        if (!v) throw new Error(`truncated varint in field ${field}`);
        fields.push({ field, wire, value: v.value });
        offset = v.next;
        break;
      }
      case WIRE_FIXED64:
        if (offset + 8 > data.length) throw new Error(`truncated fixed64 in field ${field}`);
        fields.push({ field, wire, value: data.subarray(offset, offset + 8) });
        offset += 8;
        break;
      case WIRE_LEN: {
        const len = readVarint(data, offset);
        if (!len) throw new Error(`truncated length in field ${field}`);
        const end = len.next + len.value;
        if (end > data.length) throw new Error(`field ${field} runs past the message`);
        fields.push({ field, wire, value: data.subarray(len.next, end) });
        offset = end;
        break;
      }
      case WIRE_FIXED32:
        if (offset + 4 > data.length) throw new Error(`truncated fixed32 in field ${field}`);
        fields.push({ field, wire, value: data.subarray(offset, offset + 4) });
        offset += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire} in field ${field}`);
    }
  }
  return fields;
}
