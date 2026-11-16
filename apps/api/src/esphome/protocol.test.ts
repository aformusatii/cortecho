import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EncryptionRequiredError,
  encodeNoiseFrame,
  encodePlaintext,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextOnlyError,
  PlaintextReader,
} from './framing.ts';
import {
  decodeAnnounceRequest,
  decodeGetTimeResponse,
  decodeVoiceAssistantEvent,
  decodeVoiceAssistantRequest,
  encodeAnnounceRequest,
  encodeGetTimeResponse,
  encodeVoiceAssistantEvent,
  encodeVoiceAssistantRequest,
  MSG,
  VA_EVENT,
} from './messages.ts';
import { NoiseError, NoiseInitiator, NoiseResponder, parseApiKey } from './noise.ts';
import { ProtoMessage, ProtoWriter } from './protobuf.ts';
import { posixTimezone } from './timezone.ts';

describe('protobuf', () => {
  it('round-trips the field types the API uses, skipping zero values', () => {
    const data = new ProtoWriter()
      .uint(1, 300)
      .bool(2, true)
      .bool(3, false)
      .string(4, 'Grüße')
      .fixed32(5, 1_767_225_600)
      .float(6, 0.5)
      .uint(7, 2 ** 40)
      .finish();
    const m = new ProtoMessage(data);
    expect([m.uint(1), m.bool(2), m.has(3), m.string(4), m.fixed32(5), m.float(6), m.uint(7)]).toEqual([
      300,
      true,
      false,
      'Grüße',
      1_767_225_600,
      0.5,
      2 ** 40,
    ]);
    expect(m.uint(99)).toBe(0);
  });

  it('encodes a voice assistant event the way hassmic parses it (repeated name/value pairs)', () => {
    const payload = encodeVoiceAssistantEvent(VA_EVENT.INTENT_END, {
      continue_conversation: '1',
      text: 'Hi?',
    });
    expect(decodeVoiceAssistantEvent(payload)).toEqual({
      type: VA_EVENT.INTENT_END,
      data: { continue_conversation: '1', text: 'Hi?' },
    });
    // RUN_START is type 1; type ERROR (0) is the zero value and must still decode.
    expect(decodeVoiceAssistantEvent(encodeVoiceAssistantEvent(VA_EVENT.ERROR, { code: 'x' })).type).toBe(0);
  });

  it('round-trips requests, announcements and the time', () => {
    const req = { start: true, conversationId: '', flags: 1, wakeWordPhrase: 'Computer' };
    expect(decodeVoiceAssistantRequest(encodeVoiceAssistantRequest(req))).toEqual(req);
    const ann = { mediaId: 'http://x/a.wav', text: 'Hi', preannounceMediaId: '', startConversation: false };
    expect(decodeAnnounceRequest(encodeAnnounceRequest(ann))).toEqual(ann);
    // epoch_seconds goes out as fixed32 (wire type 5): hassmic ignores anything else.
    const time = encodeGetTimeResponse(1_800_000_000, 'CET-1CEST,M3.5.0,M10.5.0/3');
    expect(time[0]).toBe((1 << 3) | 5);
    expect(decodeGetTimeResponse(time)).toEqual({
      epochSeconds: 1_800_000_000,
      timezone: 'CET-1CEST,M3.5.0,M10.5.0/3',
    });
  });
});

describe('framing', () => {
  it('reads plaintext frames split across chunks', () => {
    const bytes = Buffer.concat([
      encodePlaintext(MSG.PING_REQUEST, Buffer.alloc(0)),
      encodePlaintext(MSG.VOICE_ASSISTANT_AUDIO, Buffer.alloc(4100, 7)),
    ]);
    const reader = new PlaintextReader();
    const out = [];
    for (let i = 0; i < bytes.length; i += 333) out.push(...reader.push(bytes.subarray(i, i + 333)));
    expect(out.map((m) => [m.type, m.payload.length])).toEqual([
      [MSG.PING_REQUEST, 0],
      [MSG.VOICE_ASSISTANT_AUDIO, 4100],
    ]);
  });

  it('recognises hassmic refusing plaintext (an empty Noise frame) and plaintext on a Noise link', () => {
    expect(() => new PlaintextReader().push(encodeNoiseFrame(Buffer.alloc(0)))).toThrow(
      EncryptionRequiredError,
    );
    expect(() => new NoiseFrameReader().push(encodePlaintext(MSG.HELLO_RESPONSE, Buffer.alloc(0)))).toThrow(
      PlaintextOnlyError,
    );
  });
});

describe('noise (NNpsk0)', () => {
  const key = Buffer.alloc(32, 9);

  function handshake(initiatorKey: Buffer, responderKey: Buffer) {
    const initiator = new NoiseInitiator(initiatorKey);
    const responder = new NoiseResponder(responderKey);
    responder.readMessage1(initiator.writeMessage1());
    const { message, transport: server } = responder.writeMessage2();
    const { transport: client } = initiator.readMessage2(message);
    return { client, server };
  }

  it('completes the handshake with the same key and carries messages both ways', () => {
    const { client, server } = handshake(key, key);
    const clientCodec = new NoiseTransportCodec(client.send, client.receive);
    const serverCodec = new NoiseTransportCodec(server.send, server.receive);
    const wire = Buffer.concat([
      clientCodec.encode(MSG.HELLO_REQUEST, Buffer.from('a')),
      clientCodec.encode(MSG.PING_REQUEST, Buffer.alloc(0)),
    ]);
    expect(serverCodec.push(wire).map((m) => [m.type, m.payload.toString()])).toEqual([
      [MSG.HELLO_REQUEST, 'a'],
      [MSG.PING_REQUEST, ''],
    ]);
    expect(clientCodec.push(serverCodec.encode(MSG.GET_TIME_REQUEST, Buffer.alloc(0)))[0]?.type).toBe(
      MSG.GET_TIME_REQUEST,
    );
  });

  it('fails message 1 when the keys differ (hassmic answers "Handshake MAC failure")', () => {
    expect(() => handshake(key, Buffer.alloc(32))).toThrow(NoiseError);
  });

  it('validates ECHO_API_KEY', () => {
    expect(parseApiKey(key.toString('base64'))).toEqual(key);
    expect(() => parseApiKey('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});

describe('posixTimezone', () => {
  it('reads the rule from the end of a TZif file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zoneinfo-'));
    const rule = 'CET-1CEST,M3.5.0,M10.5.0/3';
    writeFileSync(
      path.join(dir, 'Test'),
      Buffer.concat([Buffer.from('TZif2'), Buffer.alloc(40), Buffer.from(`\n${rule}\n`)]),
    );
    expect(posixTimezone('Test', dir)).toBe(rule);
    expect(posixTimezone('Missing', dir)).toBe('');
    expect(posixTimezone('../etc/passwd', dir)).toBe('');
  });
});
