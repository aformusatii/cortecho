import net from 'node:net';
import type { EchoProbeResult, EchoProbeSuccess } from '@cortecho/shared';
import {
  type ApiMessage,
  EncryptionRequiredError,
  encodeNoiseFrame,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextCodec,
} from './framing.ts';
import { normalizeMac } from './mac.ts';
import {
  decodeDeviceInfo,
  decodeHelloResponse,
  decodeSetKeyResponse,
  encodeEmpty,
  encodeHelloRequest,
  encodeSetKeyRequest,
  MSG,
  VA_FEATURE,
} from './messages.ts';
import { NoiseInitiator, parseApiKey } from './noise.ts';

/**
 * The short ESPHome conversations the setup wizard needs, shared by the web
 * adoption flow, the doctor and `npm run echo-set-key` (spec §7.1).
 *
 * Neither function ever subscribes to the voice assistant: hassmic gives it to
 * the first subscriber only, so a probe next to a running instance must not
 * take it. The probe sends Hello + DeviceInfoRequest and nothing else;
 * `setKeyOnUnkeyedEcho` sends Hello + NoiseEncryptionSetKeyRequest.
 *
 * All of them use short-lived sockets, open one at a time and wait for the
 * socket to close before resolving, so the caller can open the next connection
 * without ever having two open to the same Echo.
 */

const CONNECT_TIMEOUT_MS = 3_000;
const PROBE_TOTAL_MS = 10_000;
/** hassmic answers SetKey immediately; no answer in 5 s means the answer was lost. */
const SET_KEY_RESPONSE_MS = 5_000;
/** How long to wait for the socket's `close` after `destroy()` (the Echo's side). */
const CLOSE_SETTLE_MS = 250;

type ServerHello = { nodeName: string; mac: string | null };

type Failure = { kind: 'unreachable' } | { kind: 'timeout' };

type PlainAttempt =
  | { kind: 'info'; hello: ServerHello | null; info: ProbeDeviceInfo }
  | { kind: 'encrypted' }
  | Failure
  | { kind: 'not-esphome' };

type NoiseAttempt =
  | { kind: 'info'; hello: ServerHello | null; info: ProbeDeviceInfo }
  | { kind: 'refused'; hello: ServerHello | null; reason: string }
  | Failure
  | { kind: 'not-esphome' };

type ProbeDeviceInfo = ReturnType<typeof decodeDeviceInfo>;

type SetKeyAttempt =
  | { kind: 'answered'; success: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'lost' }
  | Failure
  | { kind: 'not-esphome' };

export type ProbeOptions = {
  host: string;
  port: number;
  /**
   * Base64 as stored or entered. A malformed value never throws here: the probe
   * simply cannot prove a match (the route validates it first).
   */
  apiKey?: string | null;
  /** Aborting stops the attempt; the caller discards the result. */
  signal?: AbortSignal;
  /** The whole call; connect gives up after min(3 s, this). Default 10 s. */
  timeoutMs?: number;
  /** Shown in the ESPHome hello; the doctor and the CLI keep their own names. */
  clientInfo?: string;
};

export type SetKeyOutcome = 'ok' | 'refused' | 'lost' | 'unreachable';

/**
 * Outcomes:
 * - `ok`          the Echo stored the key;
 * - `refused`     the Echo has a key (the zero-PSK handshake failed) or said no;
 * - `lost`        the request was written but no answer came (the Echo may or may
 *                 not have stored it — never assume it did not);
 * - `unreachable` nothing was sent (no connection, or the handshake did not get
 *                 that far), so the Echo cannot hold this key.
 */
export type SetKeyOptions = {
  host: string;
  port: number;
  /** Base64 of exactly 32 bytes. Empty or invalid rejects: the app never clears a key (D1). */
  key: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  clientInfo?: string;
  /** The Echo's node name, once the encrypted link is up (the CLI prints it). */
  onHello?: (nodeName: string) => void;
};

/**
 * One short connection. `start` wires the codec and calls `settle` with the
 * protocol result; the runner owns the connect/total timers, the abort signal,
 * and resolves only after the socket closed.
 */
function runConnection<R>(options: {
  host: string;
  port: number;
  connectMs: number;
  totalMs: number;
  signal?: AbortSignal;
  start: (socket: net.Socket, settle: (result: R | Failure | { kind: 'not-esphome' }) => void) => void;
}): Promise<R> {
  const { host, port, connectMs, totalMs, signal, start } = options;
  return new Promise<R>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let connected = false;

    const closeWait = new Promise<void>((resolveClose) => {
      socket.once('close', () => resolveClose());
    });

    const connectTimer = setTimeout(() => settle({ kind: 'unreachable' }), connectMs);
    connectTimer.unref();
    const totalTimer = setTimeout(() => settle({ kind: 'timeout' }), totalMs);
    totalTimer.unref();

    function cleanup(): void {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    function settle(result: R | Failure | { kind: 'not-esphome' }): void {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      // The Echo must have seen the connection end before the next one opens;
      // one event-loop tick lets the peer process the close.
      void Promise.race([closeWait, sleep(CLOSE_SETTLE_MS)]).then(
        () => void setImmediate(() => resolve(result as R)),
      );
    }

    function onAbort(): void {
      settle({ kind: 'timeout' });
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      try {
        start(socket, settle);
      } catch {
        settle({ kind: 'not-esphome' });
      }
    });
    socket.once('error', () => {
      if (!connected) settle({ kind: 'unreachable' });
    });
    socket.once('close', () => {
      if (settled) return;
      settle({ kind: connected ? 'not-esphome' : 'unreachable' });
    });
  });
}

/** Runs the probe against the Echo (spec §7.1); never throws. */
export async function probeEcho(options: ProbeOptions): Promise<EchoProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TOTAL_MS;
  // One budget for the whole call, not one per attempt (spec §7.1).
  const deadline = Date.now() + timeoutMs;
  const timing = () => {
    const remaining = Math.max(1, deadline - Date.now());
    return {
      host: options.host,
      port: options.port,
      connectMs: Math.min(CONNECT_TIMEOUT_MS, remaining),
      totalMs: remaining,
      signal: options.signal,
    };
  };
  const clientInfo = options.clientInfo ?? 'cortecho-probe';
  const key = parseKeyOrNull(options.apiKey ?? null);

  const plain = await runConnection<PlainAttempt>({
    ...timing(),
    start: (socket, settle) => startPlainProbe(socket, settle, clientInfo),
  });
  if (plain.kind === 'info') return successFromInfo(plain.info, 'none');
  if (plain.kind !== 'encrypted') return failureFrom(plain);

  // Keyed Echo: plaintext is refused with an empty Noise frame.
  if (key) {
    const noise = await runConnection<NoiseAttempt>({
      ...timing(),
      start: (socket, settle) => startNoiseProbe(socket, settle, key, clientInfo),
    });
    if (noise.kind === 'info') return successFromInfo(noise.info, 'matches');
    if (noise.kind === 'refused') return successFromHello(noise.hello, 'set');
    return failureFrom(noise);
  }

  // No key to try: the zero PSK only completes on an Echo that has no key yet.
  const zero = await runConnection<NoiseAttempt>({
    ...timing(),
    start: (socket, settle) => startNoiseProbe(socket, settle, Buffer.alloc(32), clientInfo),
  });
  if (zero.kind === 'info') return successFromInfo(zero.info, 'none');
  if (zero.kind === 'refused') return successFromHello(zero.hello, 'set');
  return failureFrom(zero);
}

export async function setKeyOnUnkeyedEcho(options: SetKeyOptions): Promise<SetKeyOutcome> {
  if (options.key.trim() === '') {
    throw new Error('refusing to send an empty key: this would clear the Echo key (never done by the app)');
  }
  const key = parseApiKey(options.key);
  const timeoutMs = options.timeoutMs ?? PROBE_TOTAL_MS;
  const clientInfo = options.clientInfo ?? 'cortecho-adopt';
  /** Set when the request reached the wire: after that we may never assume "nothing happened". */
  const state = { sent: false };

  const attempt = await runConnection<SetKeyAttempt>({
    host: options.host,
    port: options.port,
    connectMs: Math.min(CONNECT_TIMEOUT_MS, timeoutMs),
    totalMs: timeoutMs,
    signal: options.signal,
    start: (socket, settle) =>
      startSetKey(socket, settle, {
        key,
        clientInfo,
        onHello: options.onHello,
        markSent: () => {
          state.sent = true;
        },
      }),
  });

  switch (attempt.kind) {
    case 'answered':
      return attempt.success ? 'ok' : 'refused';
    case 'refused':
      return 'refused';
    case 'lost':
      return 'lost';
    default:
      // A failed connection or a protocol error: the request was only ever
      // written when the encrypted link was up (state.sent).
      return state.sent ? 'lost' : 'unreachable';
  }
}

// ---------------------------------------------------------------------------
// The two conversations
// ---------------------------------------------------------------------------

function startPlainProbe(
  socket: net.Socket,
  settle: (result: PlainAttempt) => void,
  clientInfo: string,
): void {
  const codec = new PlaintextCodec();
  let sawHello = false;
  socket.on('data', (chunk) => {
    try {
      for (const { type, payload } of codec.push(chunk)) {
        if (!sawHello && type === MSG.HELLO_RESPONSE) {
          sawHello = true;
          // Hello first, then DeviceInfo: the same order the client uses.
          socket.write(codec.encode(MSG.DEVICE_INFO_REQUEST, encodeEmpty()));
          continue;
        }
        if (type !== MSG.DEVICE_INFO_RESPONSE) continue;
        const info = decodeDeviceInfo(payload);
        settle({ kind: 'info', hello: helloFromInfo(info), info });
        return;
      }
    } catch (error) {
      if (error instanceof EncryptionRequiredError) {
        settle({ kind: 'encrypted' });
        return;
      }
      settle({ kind: 'not-esphome' });
    }
  });
  socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest(clientInfo)));
}

function startNoiseProbe(
  socket: net.Socket,
  settle: (result: NoiseAttempt) => void,
  psk: Buffer,
  clientInfo: string,
): void {
  const initiator = new NoiseInitiator(psk);
  const reader = new NoiseFrameReader();
  let codec: NoiseTransportCodec | null = null;
  let frames = 0;
  let hello: ServerHello | null = null;

  const handle = (message: ApiMessage): void => {
    if (message.type === MSG.HELLO_RESPONSE) {
      if (codec) socket.write(codec.encode(MSG.DEVICE_INFO_REQUEST, encodeEmpty()));
      return;
    }
    if (message.type !== MSG.DEVICE_INFO_RESPONSE) return;
    const info = decodeDeviceInfo(message.payload);
    settle({ kind: 'info', hello: hello ?? helloFromInfo(info), info });
  };

  socket.on('data', (chunk) => {
    try {
      if (codec) {
        for (const message of codec.push(chunk)) handle(message);
        return;
      }
      const pending = reader.push(chunk);
      for (const frame of pending) {
        if (codec) {
          handle(codec.decodeFrame(frame));
          continue;
        }
        frames += 1;
        if (frames === 1) {
          // Server hello: 0x01, node name \0, MAC without colons \0.
          hello = parseServerHello(frame);
          continue;
        }
        if (frame[0] !== 0) {
          settle({ kind: 'refused', hello, reason: frame.subarray(1).toString('utf8') });
          return;
        }
        const { transport } = initiator.readMessage2(frame.subarray(1));
        codec = new NoiseTransportCodec(transport.send, transport.receive);
        socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest(clientInfo)));
      }
      if (codec) {
        const rest = reader.takeRest();
        if (rest.length > 0) for (const message of codec.push(rest)) handle(message);
      }
    } catch {
      settle({ kind: 'not-esphome' });
    }
  });

  const msg1 = initiator.writeMessage1();
  socket.write(
    Buffer.concat([
      encodeNoiseFrame(Buffer.alloc(0)),
      encodeNoiseFrame(Buffer.concat([Buffer.from([0]), msg1])),
    ]),
  );
}

function startSetKey(
  socket: net.Socket,
  settle: (result: SetKeyAttempt) => void,
  options: {
    key: Buffer;
    clientInfo: string;
    onHello?: (nodeName: string) => void;
    markSent: () => void;
  },
): void {
  const initiator = new NoiseInitiator(Buffer.alloc(32));
  const reader = new NoiseFrameReader();
  let codec: NoiseTransportCodec | null = null;
  let frames = 0;

  const handle = (message: ApiMessage): void => {
    if (message.type === MSG.HELLO_RESPONSE) {
      if (!codec) return;
      options.onHello?.(decodeHelloResponse(message.payload).name);
      // hassmic reads the key as the base64 text, exactly as Home Assistant sends it.
      options.markSent();
      socket.write(
        codec.encode(
          MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST,
          encodeSetKeyRequest(options.key.toString('base64')),
        ),
      );
      const timer = setTimeout(() => settle({ kind: 'lost' }), SET_KEY_RESPONSE_MS);
      timer.unref();
      return;
    }
    if (message.type === MSG.NOISE_ENCRYPTION_SET_KEY_RESPONSE) {
      settle({ kind: 'answered', success: decodeSetKeyResponse(message.payload).success });
    }
  };

  socket.on('data', (chunk) => {
    try {
      if (codec) {
        for (const message of codec.push(chunk)) handle(message);
        return;
      }
      const pending = reader.push(chunk);
      for (const frame of pending) {
        if (codec) {
          handle(codec.decodeFrame(frame));
          continue;
        }
        frames += 1;
        if (frames === 1) continue; // server hello
        if (frame[0] !== 0) {
          // The zero PSK did not complete: the Echo already has a key.
          settle({ kind: 'refused', reason: frame.subarray(1).toString('utf8') });
          return;
        }
        const { transport } = initiator.readMessage2(frame.subarray(1));
        codec = new NoiseTransportCodec(transport.send, transport.receive);
        socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest(options.clientInfo)));
      }
      if (codec) {
        const rest = reader.takeRest();
        if (rest.length > 0) for (const message of codec.push(rest)) handle(message);
      }
    } catch {
      settle({ kind: 'not-esphome' });
    }
  });

  const msg1 = initiator.writeMessage1();
  socket.write(
    Buffer.concat([
      encodeNoiseFrame(Buffer.alloc(0)),
      encodeNoiseFrame(Buffer.concat([Buffer.from([0]), msg1])),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function successFromInfo(info: ProbeDeviceInfo, keyState: 'none' | 'matches'): EchoProbeSuccess {
  return {
    reachable: true,
    isVoiceAssistant: (info.voiceAssistantFeatureFlags & VA_FEATURE.VOICE_ASSISTANT) !== 0,
    nodeName: info.name || null,
    mac: normalizeMac(info.macAddress),
    friendlyName: info.friendlyName || null,
    model: info.model || null,
    keyState,
  };
}

/**
 * Only the Noise server hello is readable without the key. It comes from an
 * ESPHome node, but nothing proves the voice feature until the key is known.
 */
function successFromHello(hello: ServerHello | null, keyState: 'set'): EchoProbeSuccess {
  return {
    reachable: true,
    isVoiceAssistant: null,
    nodeName: hello?.nodeName ?? null,
    mac: hello?.mac ?? null,
    friendlyName: null,
    model: null,
    keyState,
  };
}

function failureFrom(result: Failure | { kind: 'not-esphome' }): EchoProbeResult {
  if (result.kind === 'not-esphome') return { reachable: false, code: 'not-esphome' };
  return { reachable: false, code: result.kind };
}

function helloFromInfo(info: ProbeDeviceInfo): ServerHello {
  return { nodeName: info.name, mac: normalizeMac(info.macAddress) };
}

/** `0x01 || node name \0 mac (no colons) \0`; null when the body is not that. */
function parseServerHello(body: Buffer): ServerHello | null {
  if (body[0] !== 1) return null;
  const [nodeName = '', mac = ''] = body.subarray(1).toString('latin1').split('\0');
  if (nodeName === '') return null;
  return { nodeName, mac: normalizeMac(mac) };
}

function parseKeyOrNull(value: string | null): Buffer | null {
  if (!value) return null;
  try {
    return parseApiKey(value);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
