import { ProtoMessage, ProtoWriter } from './protobuf.ts';

/**
 * The ESPHome native API messages this app uses, with the message ids and
 * field numbers of esphome/components/api/api.proto (as hassmic implements
 * them in proto_esphome.c). Both directions are here: the client needs one
 * half, the fake Echo in the tests the other.
 */
export const MSG = {
  HELLO_REQUEST: 1,
  HELLO_RESPONSE: 2,
  CONNECT_REQUEST: 3,
  CONNECT_RESPONSE: 4,
  DISCONNECT_REQUEST: 5,
  DISCONNECT_RESPONSE: 6,
  PING_REQUEST: 7,
  PING_RESPONSE: 8,
  DEVICE_INFO_REQUEST: 9,
  DEVICE_INFO_RESPONSE: 10,
  GET_TIME_REQUEST: 36,
  GET_TIME_RESPONSE: 37,
  SUBSCRIBE_VOICE_ASSISTANT_REQUEST: 89,
  VOICE_ASSISTANT_REQUEST: 90,
  VOICE_ASSISTANT_RESPONSE: 91,
  VOICE_ASSISTANT_EVENT_RESPONSE: 92,
  VOICE_ASSISTANT_AUDIO: 106,
  VOICE_ASSISTANT_ANNOUNCE_REQUEST: 119,
  VOICE_ASSISTANT_ANNOUNCE_FINISHED: 120,
  NOISE_ENCRYPTION_SET_KEY_REQUEST: 124,
  NOISE_ENCRYPTION_SET_KEY_RESPONSE: 125,
} as const;

/** Readable names for logs. */
export const MSG_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(MSG).map(([name, id]) => [id, name.toLowerCase()]),
);

/** VoiceAssistantEvent (api.proto). hassmic acts on the ones marked in voice-pipeline.ts. */
export const VA_EVENT = {
  ERROR: 0,
  RUN_START: 1,
  RUN_END: 2,
  STT_START: 3,
  STT_END: 4,
  INTENT_START: 5,
  INTENT_END: 6,
  TTS_START: 7,
  TTS_END: 8,
  WAKE_WORD_START: 9,
  WAKE_WORD_END: 10,
  STT_VAD_START: 11,
  STT_VAD_END: 12,
  TTS_STREAM_START: 98,
  TTS_STREAM_END: 99,
  INTENT_PROGRESS: 100,
} as const;
export type VaEventType = (typeof VA_EVENT)[keyof typeof VA_EVENT];

export const VA_EVENT_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(VA_EVENT).map(([name, id]) => [id, name.toLowerCase()]),
);

/** VoiceAssistantFeature bits in DeviceInfoResponse.voice_assistant_feature_flags. */
export const VA_FEATURE = {
  VOICE_ASSISTANT: 1,
  SPEAKER: 2,
  API_AUDIO: 4,
  TIMERS: 8,
  ANNOUNCE: 16,
  START_CONVERSATION: 32,
} as const;

/** SubscribeVoiceAssistantRequest.flags: the mic audio comes over this connection. */
export const VA_SUBSCRIBE_API_AUDIO = 1;

/** VoiceAssistantRequest.flags */
export const VA_REQUEST_FLAG = { USE_VAD: 1, USE_WAKE_WORD: 2 } as const;

const empty = () => Buffer.alloc(0);

// ---------------------------------------------------------------------------
// Client → Echo
// ---------------------------------------------------------------------------

export function encodeHelloRequest(clientInfo: string, major = 1, minor = 10): Buffer {
  return new ProtoWriter().string(1, clientInfo).uint(2, major).uint(3, minor).finish();
}

export function encodeSubscribeVoiceAssistant(subscribe: boolean): Buffer {
  return new ProtoWriter()
    .bool(1, subscribe)
    .uint(2, subscribe ? VA_SUBSCRIBE_API_AUDIO : 0)
    .finish();
}

/** port 0 = the audio comes over the API connection; error = refuse the run. */
export function encodeVoiceAssistantResponse({ port = 0, error = false } = {}): Buffer {
  return new ProtoWriter().uint(1, port).bool(2, error).finish();
}

export type VaEventData = Record<string, string>;

export function encodeVoiceAssistantEvent(type: VaEventType, data: VaEventData = {}): Buffer {
  const w = new ProtoWriter().uint(1, type);
  for (const [name, value] of Object.entries(data)) {
    w.message(2, new ProtoWriter().string(1, name).string(2, value).finish());
  }
  return w.finish();
}

export type AnnounceRequest = {
  mediaId: string;
  text?: string;
  preannounceMediaId?: string;
  startConversation?: boolean;
};

export function encodeAnnounceRequest(req: AnnounceRequest): Buffer {
  return new ProtoWriter()
    .string(1, req.mediaId)
    .string(2, req.text ?? '')
    .string(3, req.preannounceMediaId ?? '')
    .bool(4, req.startConversation ?? false)
    .finish();
}

/** epoch_seconds is a fixed32 (hassmic reads only wire type 5), timezone a POSIX TZ rule. */
export function encodeGetTimeResponse(epochSeconds: number, timezone: string): Buffer {
  return new ProtoWriter().fixed32(1, epochSeconds).string(2, timezone).finish();
}

/** The key as Home Assistant sends it: base64 text, as bytes. Empty clears it. */
export function encodeSetKeyRequest(keyBase64: string): Buffer {
  return new ProtoWriter().bytes(1, Buffer.from(keyBase64, 'ascii')).finish();
}

export const encodeEmpty = empty;

// ---------------------------------------------------------------------------
// Echo → client
// ---------------------------------------------------------------------------

export type HelloResponse = { apiMajor: number; apiMinor: number; serverInfo: string; name: string };

export function decodeHelloResponse(data: Buffer): HelloResponse {
  const m = new ProtoMessage(data);
  return { apiMajor: m.uint(1), apiMinor: m.uint(2), serverInfo: m.string(3), name: m.string(4) };
}

export type DeviceInfo = {
  name: string;
  macAddress: string;
  esphomeVersion: string;
  model: string;
  projectName: string;
  projectVersion: string;
  manufacturer: string;
  friendlyName: string;
  voiceAssistantFeatureFlags: number;
  apiEncryptionSupported: boolean;
};

export function decodeDeviceInfo(data: Buffer): DeviceInfo {
  const m = new ProtoMessage(data);
  return {
    name: m.string(2),
    macAddress: m.string(3),
    esphomeVersion: m.string(4),
    model: m.string(6),
    projectName: m.string(8),
    projectVersion: m.string(9),
    manufacturer: m.string(12),
    friendlyName: m.string(13),
    voiceAssistantFeatureFlags: m.uint(17),
    apiEncryptionSupported: m.bool(19),
  };
}

export type VoiceAssistantRequest = {
  start: boolean;
  conversationId: string;
  flags: number;
  wakeWordPhrase: string;
};

export function decodeVoiceAssistantRequest(data: Buffer): VoiceAssistantRequest {
  const m = new ProtoMessage(data);
  return { start: m.bool(1), conversationId: m.string(2), flags: m.uint(3), wakeWordPhrase: m.string(5) };
}

export type VoiceAssistantAudio = { data: Buffer; end: boolean };

export function decodeVoiceAssistantAudio(data: Buffer): VoiceAssistantAudio {
  const m = new ProtoMessage(data);
  return { data: m.bytes(1), end: m.bool(2) };
}

export function decodeAnnounceFinished(data: Buffer): { success: boolean } {
  return { success: new ProtoMessage(data).bool(1) };
}

export function decodeSetKeyResponse(data: Buffer): { success: boolean } {
  return { success: new ProtoMessage(data).bool(1) };
}

// ---------------------------------------------------------------------------
// The other halves, for the fake Echo (tests and `npm run fake-echo`)
// ---------------------------------------------------------------------------

export function encodeHelloResponse(name: string): Buffer {
  return new ProtoWriter().uint(1, 1).uint(2, 10).string(3, 'fake-echo').string(4, name).finish();
}

export function encodeDeviceInfo(info: Partial<DeviceInfo>): Buffer {
  return new ProtoWriter()
    .string(2, info.name ?? '')
    .string(3, info.macAddress ?? '')
    .string(4, info.esphomeVersion ?? '')
    .string(6, info.model ?? '')
    .string(8, info.projectName ?? '')
    .string(9, info.projectVersion ?? '')
    .string(12, info.manufacturer ?? '')
    .string(13, info.friendlyName ?? '')
    .uint(17, info.voiceAssistantFeatureFlags ?? 0)
    .bool(19, info.apiEncryptionSupported ?? false)
    .finish();
}

export function encodeVoiceAssistantRequest(req: Partial<VoiceAssistantRequest>): Buffer {
  return new ProtoWriter()
    .bool(1, req.start ?? false)
    .string(2, req.conversationId ?? '')
    .uint(3, req.flags ?? 0)
    .string(5, req.wakeWordPhrase ?? '')
    .finish();
}

export function encodeVoiceAssistantAudio(audio: Partial<VoiceAssistantAudio>): Buffer {
  return new ProtoWriter()
    .bytes(1, audio.data ?? empty())
    .bool(2, audio.end ?? false)
    .finish();
}

export function encodeAnnounceFinished(success: boolean): Buffer {
  return new ProtoWriter().bool(1, success).finish();
}

export function decodeSubscribeVoiceAssistant(data: Buffer): { subscribe: boolean; flags: number } {
  const m = new ProtoMessage(data);
  return { subscribe: m.bool(1), flags: m.uint(2) };
}

export function decodeVoiceAssistantEvent(data: Buffer): { type: number; data: VaEventData } {
  const m = new ProtoMessage(data);
  const out: VaEventData = {};
  for (const item of m.repeated(2)) {
    const kv = new ProtoMessage(item);
    out[kv.string(1)] = kv.string(2);
  }
  return { type: m.uint(1), data: out };
}

export function decodeAnnounceRequest(data: Buffer): Required<AnnounceRequest> {
  const m = new ProtoMessage(data);
  return {
    mediaId: m.string(1),
    text: m.string(2),
    preannounceMediaId: m.string(3),
    startConversation: m.bool(4),
  };
}

export function decodeGetTimeResponse(data: Buffer): { epochSeconds: number; timezone: string } {
  const m = new ProtoMessage(data);
  return { epochSeconds: m.fixed32(1), timezone: m.string(2) };
}

export function decodeVoiceAssistantResponse(data: Buffer): { port: number; error: boolean } {
  const m = new ProtoMessage(data);
  return { port: m.uint(1), error: m.bool(2) };
}
