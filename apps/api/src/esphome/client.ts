import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { EchoConnectionState, EchoEncryption, EchoInfo, EchoProblem } from '@cortecho/shared';
import { createLogger, errorMessage } from '../lib/logger.ts';
import {
  EncryptionRequiredError,
  encodeNoiseFrame,
  type MessageCodec,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextCodec,
  PlaintextOnlyError,
} from './framing.ts';
import {
  type AnnounceRequest,
  type DeviceInfo,
  decodeAnnounceFinished,
  decodeDeviceInfo,
  decodeHelloResponse,
  decodeVoiceAssistantAudio,
  decodeVoiceAssistantRequest,
  encodeAnnounceRequest,
  encodeEmpty,
  encodeGetTimeResponse,
  encodeHelloRequest,
  encodeSubscribeVoiceAssistant,
  encodeVoiceAssistantEvent,
  encodeVoiceAssistantResponse,
  MSG,
  MSG_NAMES,
  VA_EVENT_NAMES,
  VA_FEATURE,
  type VaEventData,
  type VaEventType,
  type VoiceAssistantAudio,
  type VoiceAssistantRequest,
} from './messages.ts';
import { NoiseError, NoiseInitiator } from './noise.ts';

const log = createLogger('esphome');

/** The Echo answered our handshake with an error ("Handshake MAC failure" = not its key). */
class HandshakeRefusedError extends NoiseError {
  constructor(reason: string) {
    super(`handshake refused: ${reason || 'no reason given'}`);
    this.name = 'HandshakeRefusedError';
  }
}

export type EsphomeClientOptions = {
  host: string;
  port: number;
  /**
   * Resolves the host to a connectable literal before every connect (the
   * manager checks it is on the local network). Return null to refuse the
   * connection; the client then stops instead of retrying.
   */
  resolveHost?: (host: string) => Promise<string | null>;
  /** 32-byte API key: connect with Noise encryption. null = plaintext. */
  apiKey: Buffer | null;
  clientInfo: string;
  reconnectMinMs: number | (() => number);
  reconnectMaxMs: number | (() => number);
  pingIntervalMs: number | (() => number);
  /** No message at all for this long = the link is dead, reconnect. */
  pingTimeoutMs: number | (() => number);
  /** POSIX TZ rule sent with the time ('' = none). A function is read at each answer, so a settings change applies without a reconnect. */
  timezone: string | (() => string);
};

type ClientEvents = {
  'voice-request': [VoiceAssistantRequest];
  'voice-audio': [VoiceAssistantAudio];
  'announce-finished': [{ success: boolean }];
  /** The Echo's DeviceInfoResponse (its node name is what the manager tracks). */
  'device-info': [DeviceInfo];
  connected: [];
  disconnected: [];
};

type Phase = 'handshake' | 'hello' | 'ready';

/**
 * The app's single ESPHome API connection to hassmic. We take Home
 * Assistant's place: the Echo is the TCP server, we connect, say hello and
 * subscribe to the voice assistant (with the mic audio over this connection).
 * hassmic serves several API clients, but only the first voice assistant
 * subscriber gets the pipelines, so this class owns exactly one socket.
 *
 * Handled here: the handshake (plaintext or Noise), pings, the Echo's time
 * requests, and disconnect requests. Voice assistant traffic is emitted to
 * the pipeline. Reconnects back off from 1 s to 30 s by default.
 */
export class EsphomeClient extends EventEmitter<ClientEvents> {
  private readonly options: EsphomeClientOptions;
  private socket: net.Socket | null = null;
  private codec: MessageCodec | null = null;
  private phase: Phase = 'handshake';
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastSeenMs = 0;

  state: EchoConnectionState = 'disconnected';
  connectedSince: Date | null = null;
  lastPongAt: Date | null = null;
  lastTimeSyncAt: Date | null = null;
  reconnects = 0;
  info: DeviceInfo | null = null;
  problem: EchoProblem | null = null;

  constructor(options: EsphomeClientOptions) {
    super();
    this.options = options;
    this.backoffMs = readNumber(options.reconnectMinMs);
  }

  get encryption(): EchoEncryption {
    return this.options.apiKey ? 'noise' : 'plaintext';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Closes the socket for good (graceful shutdown, tests). */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      this.state = 'disconnected';
      return Promise.resolve();
    }
    if (this.isConnected) this.send(MSG.DISCONNECT_REQUEST, encodeEmpty());
    return new Promise((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      // Do not wait forever for the peer to acknowledge the FIN.
      setTimeout(() => socket.destroy(), 1000).unref();
    });
  }

  /** Our side of the link as the Echo sees it (the reply URL fallback). */
  get localAddress(): string | null {
    return this.socket?.localAddress?.replace(/^::ffff:/, '') ?? null;
  }

  /** The device info as the health document shows it. */
  get echoInfo(): EchoInfo | null {
    const info = this.info;
    if (!info) return null;
    return {
      name: info.name,
      friendlyName: info.friendlyName,
      model: info.model,
      version: info.projectVersion,
      supportsAnnounce: (info.voiceAssistantFeatureFlags & VA_FEATURE.ANNOUNCE) !== 0,
      supportsFollowUp: (info.voiceAssistantFeatureFlags & VA_FEATURE.START_CONVERSATION) !== 0,
    };
  }

  get isConnected(): boolean {
    return this.state === 'connected' && this.socket !== null && !this.socket.destroyed;
  }

  /** Sends one message. Returns false when there is no connection. */
  send(type: number, payload: Buffer): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.codec) return false;
    if (this.phase !== 'ready' && type !== MSG.HELLO_REQUEST) return false;
    socket.write(this.codec.encode(type, payload));
    return true;
  }

  sendEvent(type: VaEventType, data: VaEventData = {}): boolean {
    log.debug(`→ ${VA_EVENT_NAMES[type] ?? type}`, data);
    return this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, encodeVoiceAssistantEvent(type, data));
  }

  sendVoiceResponse(response: { port?: number; error?: boolean } = {}): boolean {
    return this.send(MSG.VOICE_ASSISTANT_RESPONSE, encodeVoiceAssistantResponse(response));
  }

  sendAnnounce(request: AnnounceRequest): boolean {
    log.debug('→ announce', { text: request.text });
    return this.send(MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST, encodeAnnounceRequest(request));
  }

  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.state = 'connecting';
    const { port, apiKey } = this.options;
    let host = this.options.host;
    if (this.options.resolveHost) {
      try {
        const resolved = await this.options.resolveHost(host);
        if (resolved === null) {
          this.stopped = true;
          this.state = 'disconnected';
          log.error(`refusing to connect to ${host}: it is not on the local network`);
          return;
        }
        host = resolved;
      } catch (error) {
        this.stopped = true;
        this.state = 'disconnected';
        log.error(`could not resolve ${host}: ${errorMessage(error)}`);
        return;
      }
    }
    // A stop() or a newer connect() may have happened while resolving.
    if (this.stopped || this.socket !== null) return;
    log.info(`connecting to ${host}:${port} (${apiKey ? 'encrypted' : 'plaintext'})`);

    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    // Covers connect + handshake + hello; cleared once the link is up.
    socket.setTimeout(10_000, () => socket.destroy(new Error('connect/handshake timeout')));

    let noise: { initiator: NoiseInitiator; reader: NoiseFrameReader; frames: number } | null = null;

    socket.on('connect', () => {
      if (apiKey) {
        this.phase = 'handshake';
        const initiator = new NoiseInitiator(apiKey);
        noise = { initiator, reader: new NoiseFrameReader(), frames: 0 };
        // Client hello (empty), then message 1 behind a 0x00 "no error" byte.
        const msg1 = initiator.writeMessage1();
        socket.write(
          Buffer.concat([
            encodeNoiseFrame(Buffer.alloc(0)),
            encodeNoiseFrame(Buffer.concat([Buffer.from([0]), msg1])),
          ]),
        );
      } else {
        this.codec = new PlaintextCodec();
        this.sayHello();
      }
    });

    socket.on('data', (chunk) => {
      try {
        if (noise && !this.codec) {
          const frames = noise.reader.push(chunk);
          while (frames.length > 0 && !this.codec) {
            const frame = frames.shift() as Buffer;
            noise.frames += 1;
            if (noise.frames === 1) {
              // Server hello: chosen protocol (1 = Noise), node name, MAC.
              if (frame[0] !== 1) throw new NoiseError(`the Echo picked protocol ${frame[0]}`);
              continue;
            }
            if (frame[0] !== 0) {
              throw new HandshakeRefusedError(frame.subarray(1).toString('utf8'));
            }
            const { transport } = noise.initiator.readMessage2(frame.subarray(1));
            const codec = new NoiseTransportCodec(transport.send, transport.receive);
            this.codec = codec;
            this.sayHello();
            // Whatever came in the same chunk belongs to the transport already.
            this.handleMessages(frames.map((f) => codec.decodeFrame(f)));
            const rest = noise.reader.takeRest();
            if (rest.length > 0) this.handleMessages(codec.push(rest));
          }
          return;
        }
        if (this.codec) this.handleMessages(this.codec.push(chunk));
      } catch (error) {
        this.onProtocolError(error);
        socket.destroy();
      }
    });

    socket.on('error', (error) => {
      log.warn(`socket error: ${errorMessage(error)}`);
    });

    socket.on('close', () => {
      const wasConnected = this.state === 'connected';
      this.stopPing();
      if (this.socket === socket) {
        this.socket = null;
        this.codec = null;
      }
      this.state = 'disconnected';
      this.connectedSince = null;
      if (wasConnected) {
        log.warn('connection closed');
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });
  }

  private onProtocolError(error: unknown): void {
    if (error instanceof EncryptionRequiredError) {
      this.problem = 'encryption-required';
      log.error(
        'the Echo refused plaintext: an API key is set on it (Home Assistant adopted it?). ' +
          'Add this Echo\'s key to the device, or delete state/api_key on the Echo. See README "Encryption".',
      );
    } else if (error instanceof PlaintextOnlyError) {
      this.problem = 'key-not-set';
      log.error(
        'This device has an API key but the Echo answered in plaintext. Run `npm run echo-set-key` first.',
      );
    } else if (error instanceof HandshakeRefusedError) {
      this.problem = 'invalid-key';
      log.error(
        `${errorMessage(error)}. This device's key is not the Echo's (or the Echo has none yet: ` +
          'run `npm run echo-set-key`).',
      );
    } else {
      log.error(`protocol error, reconnecting: ${errorMessage(error)}`);
    }
  }

  private sayHello(): void {
    this.phase = 'hello';
    this.send(MSG.HELLO_REQUEST, encodeHelloRequest(this.options.clientInfo));
  }

  private handleMessages(messages: { type: number; payload: Buffer }[]): void {
    for (const { type, payload } of messages) {
      this.lastSeenMs = Date.now();
      this.handleMessage(type, payload);
    }
  }

  private handleMessage(type: number, payload: Buffer): void {
    if (type !== MSG.VOICE_ASSISTANT_AUDIO) log.debug(`← ${MSG_NAMES[type] ?? type}`);
    switch (type) {
      case MSG.HELLO_RESPONSE:
        this.onHello(decodeHelloResponse(payload));
        return;
      case MSG.CONNECT_RESPONSE:
        return;
      case MSG.DEVICE_INFO_RESPONSE:
        this.info = decodeDeviceInfo(payload);
        log.info('echo device info', {
          name: this.info.name,
          friendlyName: this.info.friendlyName,
          model: this.info.model,
          version: this.info.projectVersion,
          features: this.info.voiceAssistantFeatureFlags,
        });
        this.emit('device-info', this.info);
        return;
      case MSG.PING_REQUEST:
        this.send(MSG.PING_RESPONSE, encodeEmpty());
        return;
      case MSG.PING_RESPONSE:
        this.lastPongAt = new Date();
        return;
      case MSG.GET_TIME_REQUEST:
        this.answerTime();
        return;
      case MSG.DISCONNECT_REQUEST:
        log.warn('the Echo asked to disconnect');
        this.send(MSG.DISCONNECT_RESPONSE, encodeEmpty());
        this.socket?.end();
        return;
      case MSG.VOICE_ASSISTANT_REQUEST:
        this.emit('voice-request', decodeVoiceAssistantRequest(payload));
        return;
      case MSG.VOICE_ASSISTANT_AUDIO:
        this.emit('voice-audio', decodeVoiceAssistantAudio(payload));
        return;
      case MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED:
        this.emit('announce-finished', decodeAnnounceFinished(payload));
        return;
      default:
      // Entity states and the like: we never subscribe to them, hassmic may still send a few.
    }
  }

  private onHello(hello: { apiMajor: number; apiMinor: number; serverInfo: string; name: string }): void {
    const socket = this.socket;
    if (!socket) return;
    socket.setTimeout(0);
    this.phase = 'ready';
    this.state = 'connected';
    this.problem = null;
    this.connectedSince = new Date();
    this.backoffMs = readNumber(this.options.reconnectMinMs);
    this.lastSeenMs = Date.now();
    log.info(
      `connected to ${hello.name || this.options.host} (${hello.serverInfo}, API ${hello.apiMajor}.${hello.apiMinor})`,
    );
    // hassmic answers Connect (no password) like old ESPHome; harmless otherwise.
    this.send(MSG.CONNECT_REQUEST, encodeEmpty());
    this.send(MSG.DEVICE_INFO_REQUEST, encodeEmpty());
    // Makes us the voice assistant client: hassmic logs "voice assistant: subscribed".
    this.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, encodeSubscribeVoiceAssistant(true));
    this.startPing();
    this.emit('connected');
  }

  /**
   * GetTimeRequest: hassmic asks after our first ping and then every 6 h.
   * With the key (Noise link) it sets the Echo's clock and time zone from
   * this answer; without it only its timer display uses it.
   */
  private answerTime(): void {
    const epoch = Math.floor(Date.now() / 1000);
    const timezone =
      typeof this.options.timezone === 'function' ? this.options.timezone() : this.options.timezone;
    this.send(MSG.GET_TIME_RESPONSE, encodeGetTimeResponse(epoch, timezone));
    this.lastTimeSyncAt = new Date();
    log.info(
      `answered the Echo's time request (${new Date(epoch * 1000).toISOString()}, ${timezone || 'no zone'})`,
    );
  }

  private startPing(): void {
    this.stopPing();
    // The first ping right away: hassmic asks for the time on a ping.
    this.send(MSG.PING_REQUEST, encodeEmpty());
    const pingTimeoutMs = readNumber(this.options.pingTimeoutMs);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastSeenMs > pingTimeoutMs) {
        log.warn(`nothing from the Echo for ${pingTimeoutMs} ms, reconnecting`);
        this.socket?.destroy();
        return;
      }
      this.send(MSG.PING_REQUEST, encodeEmpty());
    }, readNumber(this.options.pingIntervalMs));
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // A key problem will not fix itself: retry slowly, the log already says why.
    const reconnectMaxMs = readNumber(this.options.reconnectMaxMs);
    const delay = this.problem ? reconnectMaxMs : this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, reconnectMaxMs);
    log.info(`reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects += 1;
      void this.connect();
    }, delay);
  }
}

/** A link timing that may be a setting read at each use. */
function readNumber(value: number | (() => number)): number {
  return typeof value === 'function' ? value() : value;
}
