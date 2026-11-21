import { z } from 'zod';
import type {
  EchoConnectionState,
  EchoEncryption,
  EchoInfo,
  EchoProblem,
  PipelineState,
} from './voice.schema.ts';

// ---------------------------------------------------------------------------
// The contract for the devices API (features/devices/devices.routes.ts).
// A device key is write-only: no response contains it, only `hasKey`.
// ---------------------------------------------------------------------------

export const DEVICE_KINDS = ['echo', 'test'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** The longest prompt an Echo may carry (spec §8.3). */
export const MAX_DEVICE_PROMPT_LENGTH = 4000;

const nameField = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');
const hostField = z.string().trim().min(1, 'Enter an address.').max(253, 'Use at most 253 characters.');
const portField = z.number().int().min(1, 'Use a port between 1 and 65535.').max(65535);
const apiKeyField = z.string().trim().min(1).max(200);
const promptField = z
  .string()
  .max(MAX_DEVICE_PROMPT_LENGTH, `Use at most ${MAX_DEVICE_PROMPT_LENGTH} characters.`);

export const deviceCreateSchema = z.object({
  name: nameField,
  kind: z.enum(DEVICE_KINDS).default('echo'),
  host: hostField,
  port: portField.default(26053),
  /** Absent or null = a plaintext link. */
  apiKey: apiKeyField.nullish(),
  enabled: z.boolean().default(true),
  prompt: promptField.default(''),
});
export type DeviceCreate = z.input<typeof deviceCreateSchema>;

/** Every field optional. `apiKey: null` clears the key; absent keeps it. */
export const deviceUpdateSchema = z.object({
  name: nameField.optional(),
  kind: z.enum(DEVICE_KINDS).optional(),
  host: hostField.optional(),
  port: portField.optional(),
  apiKey: apiKeyField.nullable().optional(),
  enabled: z.boolean().optional(),
  prompt: promptField.optional(),
});
export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;

/** POST /api/devices/probe: what answers at this address, and what key state it is in. */
export const deviceProbeSchema = z.object({
  host: hostField,
  port: portField.default(26053),
  /** A pasted key, to check it against an Echo someone else secured. */
  apiKey: apiKeyField.optional(),
});
export type DeviceProbe = z.infer<typeof deviceProbeSchema>;

/** POST /api/devices/adopt: connect, secure with a generated key, and add the Echo. */
export const deviceAdoptSchema = z.object({
  host: hostField,
  port: portField.default(26053),
  /** Absent: the Echo's friendly name, made unique. */
  name: nameField.optional(),
  kind: z.enum(DEVICE_KINDS).default('echo'),
  /** Only for an Echo that already has a key (set by another app): use this one instead of SetKey. */
  apiKey: apiKeyField.optional(),
});
export type DeviceAdopt = z.infer<typeof deviceAdoptSchema>;

/**
 * 'none'   the Echo has no key (plaintext works, or the zero-PSK handshake does)
 * 'set'    the Echo has a key and we could not prove it is the one we were given
 * 'matches' the given key completed the Noise handshake
 */
export const ECHO_KEY_STATES = ['none', 'set', 'matches'] as const;
export type EchoKeyState = (typeof ECHO_KEY_STATES)[number];

export type EchoProbeFailureCode = 'unreachable' | 'not-esphome' | 'timeout';

export type EchoProbeSuccess = {
  reachable: true;
  /** null = the feature flags were needed but are unreadable without the Echo's key. */
  isVoiceAssistant: boolean | null;
  nodeName: string | null;
  /** 12 lower-case hex (the Echo's identity, spec §1.2 S3). */
  mac: string | null;
  friendlyName: string | null;
  model: string | null;
  keyState: EchoKeyState;
};

export type EchoProbeFailure = { reachable: false; code: EchoProbeFailureCode };

/** The result of a probe never contains the key it was given. */
export type EchoProbeResult = EchoProbeSuccess | EchoProbeFailure;

export const deviceSettingsPatchSchema = z.object({
  /** The settings version the form was loaded with; a stale value gets 409. */
  version: z.number().int().min(0),
  /** key → new value, or null to inherit the global value again. */
  changes: z.record(z.string(), z.unknown()),
});
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

/** One Echo as the UI sees it: no key, plus its live connection state. */
export type DeviceStatus = {
  id: number;
  name: string;
  kind: DeviceKind;
  host: string;
  port: number;
  enabled: boolean;
  prompt: string;
  /** hassmic's node name, learned at the first connect. */
  nodeName: string | null;
  /** hassmic's DeviceInfo MAC as 12 lower-case hex, learned at the first connect. */
  mac: string | null;
  hasKey: boolean;
  /** 'disabled' when the device is disabled. */
  state: EchoConnectionState;
  /** From hasKey: a Noise link needs the key. */
  encryption: EchoEncryption;
  /** The manager's problem wins over the client's. */
  problem: EchoProblem | null;
  connectedSince: string | null;
  lastPongAt: string | null;
  reconnects: number;
  lastTimeSyncAt: string | null;
  info: EchoInfo | null;
  pipeline: { state: PipelineState };
  /** True when the Echo has a live conversation (memory, possibly a pending confirm). */
  hasSession: boolean;
  /** How many setting keys this Echo overrides. */
  overrideCount: number;
};

/** GET /api/devices/:id/settings: the overlays and the resolved values (no secrets). */
export type DeviceSettingsDocument = {
  version: number;
  overrides: Record<string, unknown>;
  effective: Record<string, unknown>;
};

/** POST /api/devices/:id/test-sound (spec §7.5): the chime the Echo was given. */
export type TestSoundResult = {
  /** The Echo fetched the chime from the reply endpoint. */
  downloaded: boolean;
  /** The Echo sent AnnounceFinished{success:true}. */
  finished: boolean;
  /** The URL the Echo was given (a current reply id). */
  url: string;
};
