import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  type ApiMessage,
  encodeNoiseFrame,
  type MessageCodec,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextCodec,
} from './framing.ts';
import {
  decodeAnnounceRequest,
  decodeGetTimeResponse,
  decodeSubscribeVoiceAssistant,
  decodeVoiceAssistantEvent,
  decodeVoiceAssistantResponse,
  encodeAnnounceFinished,
  encodeDeviceInfo,
  encodeEmpty,
  encodeHelloResponse,
  encodeVoiceAssistantAudio,
  encodeVoiceAssistantRequest,
  MSG,
  VA_EVENT,
  VA_EVENT_NAMES,
  VA_FEATURE,
  VA_REQUEST_FLAG,
  type VaEventData,
} from './messages.ts';
import { NoiseResponder } from './noise.ts';
import { ProtoMessage, ProtoWriter } from './protobuf.ts';

/**
 * A stand-in for hassmic in ESPHome mode (proto_esphome.c), for the tests and
 * `npm run fake-echo`:
 *
 * - plaintext, or Noise with an API key (plaintext is then refused with an
 *   empty Noise frame, like hassmic); SetKey over a zero-PSK link sets a key
 * - hello / connect / device info / ping, a GetTimeRequest after the first
 *   ping, one voice assistant subscriber
 * - a wake word run: VoiceAssistantRequest(start) + mic audio in 4 KiB
 *   VoiceAssistantAudio pieces, then end-of-audio (the Echo hears the end
 *   itself); the mic stops on STT_VAD_END / STT_END / ERROR
 * - TTS_END → fetches the URL (WAV or MP3 only), "plays" it, then
 *   VoiceAssistantAnnounceFinished; INTENT_END continue_conversation=1 →
 *   a follow-up run after playback
 * - announcements, aborts (start=false), and dropping the connection
 */
export type FakeEchoOptions = {
  port?: number;
  /** 32-byte key: only Noise connections with this key get in. */
  apiKey?: Buffer | null;
  /** Delay between the end of the download and "played" (the Echo plays in real time). */
  playedDelayMs?: number;
  /** Send mic audio in real time (true) or as fast as possible (false). */
  realtime?: boolean;
  /** Fetches reply/announcement audio. Defaults to the global fetch. */
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Mic audio of a follow-up run (default: 3 s of silence). */
  followUpAudio?: Buffer;
  /**
   * hassmic's experimental "end_of_request" setting (off by default, as on
   * the real Echo): on = the Echo sends end-of-audio after the request;
   * off = it keeps streaming the room until the app ends listening.
   */
  endOfRequest?: boolean;
  wakeWordPhrase?: string;
  /** hassmic's node name in DeviceInfoResponse (the identity check reads it). */
  nodeName?: string;
};

export type ReceivedEvent = { type: string; data: VaEventData };

export type PlayedMedia = {
  url: string;
  kind: 'reply' | 'announcement';
  format: 'wav' | 'mp3' | 'unsupported' | 'failed';
  sampleRate: number;
  bytes: number;
};

type FakeEchoEvents = {
  message: [ApiMessage];
  event: [ReceivedEvent];
  played: [PlayedMedia];
  connected: [];
  disconnected: [];
};

export type EchoState = 'idle' | 'listening' | 'thinking' | 'speaking';

const MIC_RATE = 16_000;
const MIC_CHUNK_BYTES = 4096; // hassmic's audio(): 4096-byte pieces
const ZERO_PSK = Buffer.alloc(32);

type Connection = {
  socket: net.Socket;
  codec: MessageCodec | null;
  keyed: boolean;
};

export class FakeEcho extends EventEmitter<FakeEchoEvents> {
  private server: net.Server | null = null;
  private readonly connections = new Set<Connection>();
  private va: Connection | null = null;
  private readonly options: Required<Omit<FakeEchoOptions, 'apiKey'>> & { apiKey: Buffer | null };
  private timeAsked = false;
  private continueConversation = false;
  private micOpen = false;
  private cancelled = false;
  private mediaBusy = false;

  /** Every VA event the app sent, in order. */
  readonly events: ReceivedEvent[] = [];
  /** Every message the app sent (all connections). */
  readonly received: ApiMessage[] = [];
  /** Media the Echo fetched and played. */
  readonly played: PlayedMedia[] = [];
  /** GetTimeResponses, and whether they came over a keyed link (only those set hassmic's clock). */
  readonly timeAnswers: { epochSeconds: number; timezone: string; keyed: boolean }[] = [];
  /** Announcements requested, with what the Echo answered. */
  readonly announcements: { mediaId: string; text: string; success: boolean }[] = [];
  /** VA events that arrived for a run after it was aborted (hassmic drops them; should stay 0). */
  eventsAfterAbort = 0;
  /** Error sounds played (any ERROR code but stt-no-text-recognized, or a refused run). */
  errorSounds = 0;
  /** Runs started (wake word and follow-ups). */
  runs = 0;
  state: EchoState = 'idle';
  port = 0;
  /** How the Echo downloads media; tests point it at the app (`createTestRuntime().fetchAudio`). */
  fetchAudio: (url: string) => Promise<Buffer>;
  /** Mic audio of the next follow-up run. */
  followUpAudio: Buffer;
  /** See FakeEchoOptions.endOfRequest. */
  endOfRequest: boolean;

  constructor(options: FakeEchoOptions = {}) {
    super();
    this.options = {
      port: 0,
      apiKey: null,
      playedDelayMs: 20,
      realtime: false,
      fetchAudio: defaultFetch,
      followUpAudio: Buffer.alloc(MIC_RATE * 2 * 3),
      endOfRequest: false,
      wakeWordPhrase: 'Computer',
      nodeName: 'fake-echo',
      ...options,
    };
    this.fetchAudio = this.options.fetchAudio;
    this.followUpAudio = this.options.followUpAudio;
    this.endOfRequest = this.options.endOfRequest;
  }

  get apiKey(): Buffer | null {
    return this.options.apiKey;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.listen(this.options.port, '127.0.0.1', () => {
        this.port = (server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The Echo rebooting / Wi-Fi dropping. */
  dropConnection(): void {
    for (const c of this.connections) c.socket.destroy();
  }

  get isSubscribed(): boolean {
    return this.va !== null && !this.va.socket.destroyed;
  }

  eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }

  clear(): void {
    this.events.length = 0;
    this.received.length = 0;
    this.played.length = 0;
    this.announcements.length = 0;
  }

  /** Waits for the first VA event of `type` at or after index `from`. */
  waitForEvent(type: string, { from = 0, timeoutMs = 5000 } = {}): Promise<ReceivedEvent> {
    const existing = this.events.slice(from).find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);
    return this.waitOn('event', (e: ReceivedEvent) => e.type === type, timeoutMs, `event "${type}"`);
  }

  waitForPlayed(timeoutMs = 5000): Promise<PlayedMedia> {
    return this.waitOn('played', () => true, timeoutMs, 'played media');
  }

  waitForIdle(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state === 'idle' && !this.mediaBusy) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error(`echo not idle (${this.state})`));
        setTimeout(check, 5);
      };
      check();
    });
  }

  /**
   * A wake word run: request, then the mic audio, then end-of-audio. Stops
   * streaming when the app ends listening (STT_VAD_END / STT_END / ERROR).
   */
  async runPipeline(pcm: Buffer): Promise<void> {
    const va = this.va;
    if (!va) throw new Error('no voice assistant subscriber');
    this.runs += 1;
    this.cancelled = false;
    this.continueConversation = false;
    this.micOpen = true;
    this.state = 'listening';
    this.sendTo(
      va,
      MSG.VOICE_ASSISTANT_REQUEST,
      encodeVoiceAssistantRequest({
        start: true,
        flags: VA_REQUEST_FLAG.USE_VAD,
        // hassmic sends the phrase with local wake word detection, follow-ups included.
        wakeWordPhrase: this.options.wakeWordPhrase,
      }),
    );
    // Without end_of_request the mic keeps streaming the (quiet) room after
    // the request until the app ends listening; 20 s at most here.
    const room = Buffer.alloc(MIC_RATE * 2 * 20);
    const stream = this.endOfRequest ? pcm : Buffer.concat([pcm, room]);
    for (let offset = 0; offset < stream.length && this.micOpen; offset += MIC_CHUNK_BYTES) {
      if (va.socket.destroyed) return;
      this.sendTo(
        va,
        MSG.VOICE_ASSISTANT_AUDIO,
        encodeVoiceAssistantAudio({ data: stream.subarray(offset, offset + MIC_CHUNK_BYTES) }),
      );
      const chunkMs = (MIC_CHUNK_BYTES / 2 / MIC_RATE) * 1000;
      await sleep(this.options.realtime ? chunkMs : 1);
    }
    if (this.micOpen && !va.socket.destroyed) {
      // The Echo heard the end of the request itself (micend): end-of-audio.
      this.micOpen = false;
      this.sendTo(va, MSG.VOICE_ASSISTANT_AUDIO, encodeVoiceAssistantAudio({ end: true }));
      if (this.state === 'listening') this.state = 'thinking';
    }
  }

  /** The action button / "Computer, stop" while listening or thinking: start=false alone (cancel()). */
  abort(): void {
    if (!this.va) return;
    this.cancelled = true;
    this.micOpen = false;
    this.state = 'idle';
    this.sendTo(this.va, MSG.VOICE_ASSISTANT_REQUEST, encodeVoiceAssistantRequest({ start: false }));
  }

  // -------------------------------------------------------------------------

  private waitOn<K extends 'event' | 'played', T>(
    name: K,
    match: (value: T) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(name, listener as never);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const listener = (value: T) => {
        if (!match(value)) return;
        clearTimeout(timer);
        this.off(name, listener as never);
        resolve(value);
      };
      this.on(name, listener as never);
    });
  }

  private sendTo(conn: Connection, type: number, payload: Buffer): void {
    if (!conn.codec || conn.socket.destroyed) return;
    conn.socket.write(conn.codec.encode(type, payload));
  }

  private onConnection(socket: net.Socket): void {
    if (this.connections.size >= 4) {
      socket.destroy(); // hassmic: MAX_CLIENTS
      return;
    }
    const conn: Connection = { socket, codec: null, keyed: false };
    this.connections.add(conn);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections.delete(conn);
      if (this.va === conn) {
        // The voice assistant's client left: pipelines end.
        this.va = null;
        this.micOpen = false;
        this.state = 'idle';
        this.emit('disconnected');
      }
    });

    let mode: 'unknown' | 'plaintext' | 'noise' = 'unknown';
    const noiseReader = new NoiseFrameReader();
    let responder: NoiseResponder | null = null;
    let frames = 0;

    socket.on('data', (chunk) => {
      try {
        if (mode === 'unknown') {
          mode = chunk[0] === 1 ? 'noise' : 'plaintext';
          if (mode === 'plaintext' && this.options.apiKey) {
            // hassmic: "plaintext connection refused, the device has a key"
            socket.end(encodeNoiseFrame(Buffer.alloc(0)));
            return;
          }
          if (mode === 'plaintext') conn.codec = new PlaintextCodec();
        }
        if (mode === 'noise' && !conn.codec) {
          for (const frame of noiseReader.push(chunk)) {
            frames += 1;
            if (frames === 1) continue; // client hello, ignored
            const keyed = this.options.apiKey !== null;
            responder = new NoiseResponder(this.options.apiKey ?? ZERO_PSK);
            const hello = Buffer.concat([
              Buffer.from([1]),
              Buffer.from('fake-echo\x00020000000001\x00', 'latin1'),
            ]);
            try {
              responder.readMessage1(frame.subarray(1));
            } catch {
              socket.write(encodeNoiseFrame(hello));
              socket.end(encodeNoiseFrame(Buffer.from('\x01Handshake MAC failure', 'latin1')));
              return;
            }
            const { message, transport } = responder.writeMessage2();
            socket.write(encodeNoiseFrame(hello));
            socket.write(encodeNoiseFrame(Buffer.concat([Buffer.from([0]), message])));
            conn.codec = new NoiseTransportCodec(transport.send, transport.receive);
            conn.keyed = keyed;
            const rest = noiseReader.takeRest();
            if (rest.length > 0) for (const m of conn.codec.push(rest)) this.onMessage(conn, m);
            return;
          }
          return;
        }
        if (conn.codec) for (const m of conn.codec.push(chunk)) this.onMessage(conn, m);
      } catch {
        socket.destroy();
      }
    });
  }

  private onMessage(conn: Connection, message: ApiMessage): void {
    this.received.push(message);
    this.emit('message', message);
    const { type, payload } = message;
    switch (type) {
      case MSG.HELLO_REQUEST:
        this.sendTo(conn, MSG.HELLO_RESPONSE, encodeHelloResponse('fake-echo'));
        this.emit('connected');
        return;
      case MSG.CONNECT_REQUEST:
        this.sendTo(conn, MSG.CONNECT_RESPONSE, encodeEmpty());
        return;
      case MSG.DEVICE_INFO_REQUEST:
        this.sendTo(
          conn,
          MSG.DEVICE_INFO_RESPONSE,
          encodeDeviceInfo({
            name: this.options.nodeName,
            friendlyName: `Fake Echo (${this.options.nodeName})`,
            macAddress: '02:00:00:00:00:01',
            esphomeVersion: '2025.5.0',
            model: 'Echo Dot (2nd Gen)',
            projectName: 'hassmic.echo-dot-2',
            projectVersion: 'test',
            manufacturer: 'Amazon',
            voiceAssistantFeatureFlags:
              VA_FEATURE.VOICE_ASSISTANT |
              VA_FEATURE.API_AUDIO |
              VA_FEATURE.TIMERS |
              VA_FEATURE.ANNOUNCE |
              VA_FEATURE.START_CONVERSATION,
            apiEncryptionSupported: true,
          }),
        );
        return;
      case MSG.PING_REQUEST:
        this.sendTo(conn, MSG.PING_RESPONSE, encodeEmpty());
        // hassmic asks for the time on the first ping (then every 6 h).
        if (!this.timeAsked) {
          this.timeAsked = true;
          this.sendTo(conn, MSG.GET_TIME_REQUEST, encodeEmpty());
        }
        return;
      case MSG.GET_TIME_RESPONSE:
        this.timeAnswers.push({ ...decodeGetTimeResponse(payload), keyed: conn.keyed });
        return;
      case MSG.DISCONNECT_REQUEST:
        this.sendTo(conn, MSG.DISCONNECT_RESPONSE, encodeEmpty());
        conn.socket.end();
        return;
      case MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST: {
        const { subscribe } = decodeSubscribeVoiceAssistant(payload);
        if (subscribe && this.va && this.va !== conn) return; // "a second client tried to subscribe, ignored"
        this.va = subscribe ? conn : null;
        return;
      }
      case MSG.VOICE_ASSISTANT_RESPONSE:
        if (decodeVoiceAssistantResponse(payload).error) {
          this.errorSounds += 1;
          this.state = 'idle';
        }
        return;
      case MSG.VOICE_ASSISTANT_EVENT_RESPONSE:
        this.onEvent(decodeVoiceAssistantEvent(payload));
        return;
      case MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST:
        void this.onAnnounce(conn, decodeAnnounceRequest(payload));
        return;
      case MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST: {
        // Only over an encrypted link (zero PSK while no key is set), like hassmic.
        const key = Buffer.from(new ProtoMessage(payload).string(1), 'base64');
        const ok = conn.codec instanceof NoiseTransportCodec && key.length === 32;
        if (ok) {
          this.options.apiKey = key;
          conn.keyed = true;
        }
        this.sendTo(conn, MSG.NOISE_ENCRYPTION_SET_KEY_RESPONSE, new ProtoWriter().bool(1, ok).finish());
        return;
      }
    }
  }

  private onEvent({ type, data }: { type: number; data: VaEventData }): void {
    const name = VA_EVENT_NAMES[type] ?? String(type);
    // hassmic drops what the app still reports of an aborted run, until the next RUN_START.
    if (this.cancelled && type !== VA_EVENT.RUN_START) {
      this.eventsAfterAbort += 1;
      return;
    }
    if (type === VA_EVENT.RUN_START) this.cancelled = false;
    const event = { type: name, data };
    this.events.push(event);
    switch (type) {
      case VA_EVENT.STT_START:
        this.state = 'listening';
        break;
      case VA_EVENT.STT_VAD_END:
      case VA_EVENT.STT_END:
        this.micOpen = false;
        if (this.state === 'listening') this.state = 'thinking';
        break;
      case VA_EVENT.INTENT_END:
        this.continueConversation = data.continue_conversation === '1';
        break;
      case VA_EVENT.TTS_END:
        if (data.url) void this.playReply(data.url);
        break;
      case VA_EVENT.RUN_END:
        if (!this.mediaBusy && this.state !== 'speaking') this.state = 'idle';
        break;
      case VA_EVENT.ERROR:
        this.micOpen = false;
        if (data.code !== 'stt-no-text-recognized') this.errorSounds += 1;
        if (this.state !== 'speaking') this.state = 'idle';
        break;
    }
    this.emit('event', event);
  }

  private async playReply(url: string): Promise<void> {
    if (this.mediaBusy) return;
    this.mediaBusy = true;
    this.state = 'speaking';
    const media = await this.fetchMedia(url, 'reply');
    await sleep(this.options.playedDelayMs);
    this.mediaBusy = false;
    if (this.cancelled) return;
    // Replies go through the announcement path in hassmic, so they end with AnnounceFinished.
    if (this.va) this.sendTo(this.va, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(true));
    this.state = 'idle';
    this.played.push(media);
    this.emit('played', media);
    if (this.continueConversation && this.va) {
      // core_pipeline_finish with barge_in: wake sound, then a new run without the wake word.
      this.continueConversation = false;
      void this.runPipeline(this.followUpAudio);
    }
  }

  private async onAnnounce(conn: Connection, req: { mediaId: string; text: string }): Promise<void> {
    if (this.mediaBusy) {
      this.announcements.push({ mediaId: req.mediaId, text: req.text, success: false });
      this.sendTo(conn, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(false));
      return;
    }
    this.mediaBusy = true;
    this.state = 'speaking';
    const media = await this.fetchMedia(req.mediaId, 'announcement');
    await sleep(this.options.playedDelayMs);
    const success = media.format === 'wav' || media.format === 'mp3';
    this.mediaBusy = false;
    this.state = 'idle';
    this.announcements.push({ mediaId: req.mediaId, text: req.text, success });
    this.played.push(media);
    this.sendTo(conn, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(success));
    this.emit('played', media);
  }

  private async fetchMedia(url: string, kind: PlayedMedia['kind']): Promise<PlayedMedia> {
    let body: Buffer;
    try {
      body = await this.fetchAudio(url);
    } catch {
      return { url, kind, format: 'failed', sampleRate: 0, bytes: 0 };
    }
    const head = body.toString('latin1', 0, 4);
    if (head === 'RIFF' && body.toString('latin1', 8, 12) === 'WAVE') {
      return {
        url,
        kind,
        format: 'wav',
        sampleRate: body.readUInt32LE(24),
        bytes: Math.max(0, body.length - 44),
      };
    }
    if (head === 'fLaC' || head === 'OggS')
      return { url, kind, format: 'unsupported', sampleRate: 0, bytes: 0 };
    return { url, kind, format: 'mp3', sampleRate: 0, bytes: body.length };
  }
}

async function defaultFetch(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synthetic "speech": a vowel-like tone with a syllable rhythm, loud enough
 * for the VAD guard. Surrounded by silence it looks like a short request.
 */
export function syntheticSpeech({
  leadSilenceMs = 300,
  speechMs = 1200,
  trailSilenceMs = 600,
  sampleRate = MIC_RATE,
  amplitude = 0.3,
} = {}): Buffer {
  const total = Math.round(((leadSilenceMs + speechMs + trailSilenceMs) / 1000) * sampleRate);
  const speechStart = Math.round((leadSilenceMs / 1000) * sampleRate);
  const speechEnd = speechStart + Math.round((speechMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    let value = (Math.random() - 0.5) * 0.002; // faint room noise
    if (i >= speechStart && i < speechEnd) {
      const t = i / sampleRate;
      const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t); // ~4 syllables/s
      value +=
        (amplitude * envelope * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t))) /
        1.5;
    }
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return pcm;
}
