import { describe, expect, it } from 'vitest';
import {
  encodeAnnounceFinished,
  encodeAnnounceRequest,
  encodeDeviceInfo,
  encodeGetTimeResponse,
  encodeHelloRequest,
  encodeHelloResponse,
  encodeSetKeyRequest,
  encodeSubscribeVoiceAssistant,
  encodeVoiceAssistantAudio,
  encodeVoiceAssistantEvent,
  encodeVoiceAssistantRequest,
  encodeVoiceAssistantResponse,
  MSG,
  VA_EVENT,
  VA_FEATURE,
  VA_REQUEST_FLAG,
} from './messages.ts';
import { ProtoMessage } from './protobuf.ts';

/**
 * Guards the simulator's fidelity against proto_esphome.c (the code wins over
 * docs). Every message id and field number the simulator uses is listed here
 * with the C line it comes from, and checked against `messages.ts` — so the
 * two sides cannot drift together.
 */

describe('message ids (proto_esphome.c enum, line 97)', () => {
  const cases: [keyof typeof MSG, number][] = [
    ['HELLO_REQUEST', 1],
    ['HELLO_RESPONSE', 2],
    ['CONNECT_REQUEST', 3],
    ['CONNECT_RESPONSE', 4],
    ['DISCONNECT_REQUEST', 5],
    ['DISCONNECT_RESPONSE', 6],
    ['PING_REQUEST', 7],
    ['PING_RESPONSE', 8],
    ['DEVICE_INFO_REQUEST', 9],
    ['DEVICE_INFO_RESPONSE', 10],
    ['LIST_ENTITIES_REQUEST', 11],
    ['LIST_ENTITIES_DONE', 19],
    ['SUBSCRIBE_STATES', 20],
    ['GET_TIME_REQUEST', 36],
    ['GET_TIME_RESPONSE', 37],
    ['SUBSCRIBE_VOICE_ASSISTANT_REQUEST', 89],
    ['VOICE_ASSISTANT_REQUEST', 90],
    ['VOICE_ASSISTANT_RESPONSE', 91],
    ['VOICE_ASSISTANT_EVENT_RESPONSE', 92],
    ['VOICE_ASSISTANT_AUDIO', 106],
    ['VOICE_ASSISTANT_ANNOUNCE_REQUEST', 119],
    ['VOICE_ASSISTANT_ANNOUNCE_FINISHED', 120],
    ['NOISE_ENCRYPTION_SET_KEY_REQUEST', 124],
    ['NOISE_ENCRYPTION_SET_KEY_RESPONSE', 125],
  ];
  for (const [name, id] of cases) {
    it(`${name} is ${id}`, () => {
      expect(MSG[name]).toBe(id);
    });
  }
});

describe('voice assistant event ids (proto_esphome.c enum, line 121)', () => {
  const cases: [keyof typeof VA_EVENT, number][] = [
    ['ERROR', 0],
    ['RUN_START', 1],
    ['RUN_END', 2],
    ['STT_START', 3],
    ['STT_END', 4],
    ['INTENT_START', 5],
    ['INTENT_END', 6],
    ['TTS_START', 7],
    ['TTS_END', 8],
    ['WAKE_WORD_START', 9],
    ['WAKE_WORD_END', 10],
    ['STT_VAD_START', 11],
    ['STT_VAD_END', 12],
    ['TTS_STREAM_START', 98],
    ['TTS_STREAM_END', 99],
    ['INTENT_PROGRESS', 100],
  ];
  for (const [name, id] of cases) {
    it(`${name} is ${id}`, () => {
      expect(VA_EVENT[name]).toBe(id);
    });
  }
});

describe('feature and request flags (proto_esphome.c enum, line 123)', () => {
  it('matches the VoiceAssistantFeature bits', () => {
    expect(VA_FEATURE).toEqual({
      VOICE_ASSISTANT: 1,
      SPEAKER: 2,
      API_AUDIO: 4,
      TIMERS: 8,
      ANNOUNCE: 16,
      START_CONVERSATION: 32,
    });
  });
  it('matches the VoiceAssistantRequest flags (USE_VAD, USE_WAKE_WORD)', () => {
    expect(VA_REQUEST_FLAG).toEqual({ USE_VAD: 1, USE_WAKE_WORD: 2 });
  });
});

function fieldsOf(buffer: Buffer): number[] {
  return [...new Set(new ProtoMessage(buffer).fields.map((field) => field.field))].sort((a, b) => a - b);
}

describe('field numbers (proto_esphome.c send_* / encode functions)', () => {
  it('HelloRequest (send to us: encodeHelloRequest)', () => {
    expect(fieldsOf(encodeHelloRequest('cortecho'))).toEqual([1, 2, 3]);
  });

  it('HelloResponse (handle HELLO_REQ, line 1621)', () => {
    expect(fieldsOf(encodeHelloResponse('echo', 'hassmic 1'))).toEqual([1, 2, 3, 4]);
  });

  it('SubscribeVoiceAssistantRequest (encodeSubscribeVoiceAssistant)', () => {
    expect(fieldsOf(encodeSubscribeVoiceAssistant(true))).toEqual([1, 2]);
  });

  it('VoiceAssistantResponse (encodeVoiceAssistantResponse)', () => {
    expect(fieldsOf(encodeVoiceAssistantResponse({ port: 0, error: true }))).toEqual([2]);
  });

  it('VoiceAssistantEvent (send_va VA_EVENT; the data is name/value pairs)', () => {
    const event = encodeVoiceAssistantEvent(VA_EVENT.INTENT_END, { continue_conversation: '1' });
    expect(fieldsOf(event)).toEqual([1, 2]);
    const data = new ProtoMessage(event).repeated(2)[0];
    expect(data).toBeDefined();
    expect(fieldsOf(data as Buffer)).toEqual([1, 2]);
  });

  it('VoiceAssistantAnnounceRequest (on_announce, line 1459)', () => {
    expect(
      fieldsOf(
        encodeAnnounceRequest({ mediaId: 'a', text: 'b', preannounceMediaId: 'c', startConversation: true }),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('GetTimeResponse (handle GET_TIME_RESP, line 1631)', () => {
    expect(fieldsOf(encodeGetTimeResponse(1_700_000_000, 'UTC0'))).toEqual([1, 2]);
  });

  it('NoiseEncryptionSetKeyRequest (SET_KEY_REQ, line 1732)', () => {
    expect(fieldsOf(encodeSetKeyRequest('a2V5'))).toEqual([1]);
  });

  it('DeviceInfoResponse (send_device_info, line 1494)', () => {
    const info = encodeDeviceInfo({
      name: 'echo-dot-2-505cd5',
      macAddress: '50:5C:D5:00:00:00',
      esphomeVersion: '2025.5.0',
      model: 'Echo Dot 2 (biscuit)',
      projectName: 'hassmic.echo-dot-2',
      projectVersion: '2026.11.08.115848',
      manufacturer: 'Amazon',
      friendlyName: 'Echo Dot 2 505cd5',
      buildTime: 'Nov  8 2026 12:00:00',
      provisionable: false,
      voiceAssistantFeatureFlags: VA_FEATURE.VOICE_ASSISTANT,
      apiEncryptionSupported: true,
    });
    expect(fieldsOf(info)).toEqual([2, 3, 4, 5, 6, 8, 9, 12, 13, 17, 19]);
  });

  it('VoiceAssistantRequest (start, line 1302): fields 1-5 with the audio settings', () => {
    const start = encodeVoiceAssistantRequest({
      start: true,
      flags: VA_REQUEST_FLAG.USE_VAD,
      wakeWordPhrase: 'Computer',
    });
    expect(fieldsOf(start)).toEqual([1, 3, 4, 5]);
    const audioSettings = new ProtoMessage(start).bytes(4);
    expect(fieldsOf(audioSettings)).toEqual([3]); // volume_multiplier, a float
  });

  it('VoiceAssistantAudio (audio / end_audio, line 1318)', () => {
    expect(fieldsOf(encodeVoiceAssistantAudio({ data: Buffer.alloc(4), end: true }))).toEqual([1, 2]);
  });

  it('VoiceAssistantAnnounceFinished (played, line 1362)', () => {
    expect(fieldsOf(encodeAnnounceFinished(true))).toEqual([1]);
  });
});
