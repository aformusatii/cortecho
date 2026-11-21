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
 *   ping (then every 6 h; SUBSCRIBE_STATES forces one), one voice assistant
 *   subscriber (only that client may unsubscribe)
 * - a wake word run: VoiceAssistantRequest(start) with the audio settings and
 *   wake phrase, the 800 ms lead-in, then mic audio in 4 KiB
 *   VoiceAssistantAudio pieces; the mic stops on STT_VAD_END / STT_END / ERROR
 * - a stop-word transcript cancels the run (start=false alone, later events
 *   dropped); TTS_END → fetches the URL (WAV or MP3 only), "plays" it for its
 *   real length (timing 'real'), then VoiceAssistantAnnounceFinished;
 *   INTENT_END continue_conversation=1 → a follow-up run after the wake sound
 * - announcements (preannounce + media + start_conversation), aborts, dropping
 *   the connection, and the 30 s pipeline timeout (per state)
 *
 * Fidelity is driven by `timing`: 'real' (the smoke suite) streams the mic in
 * real time, sends the 800 ms lead-in, plays replies for their real length and
 * waits the wake-sound gap; 'fast' (unit tests) skips the real-time bits so
 * `npm test` stays quick.
 */
export type FakeEchoOptions = {
  port?: number;
  /** Address to listen on (the smoke suite binds 0.0.0.0 so Cortecho can connect). */
  bind?: string;
  /** 32-byte key: only Noise connections with this key get in. */
  apiKey?: Buffer | null;
  /** 'real' = faithful timing; 'fast' = quick (unit tests). Default 'fast'. */
  timing?: 'real' | 'fast';
  /** Delay between the end of the download and "played" (fast timing). */
  playedDelayMs?: number;
  /** Send mic audio in real time (true) or as fast as possible (false). */
  realtime?: boolean;
  /** Give up after this long in LISTENING or THINKING (hassmic's PIPELINE_TIMEOUT). */
  pipelineTimeoutMs?: number;
  /** Fetches reply/announcement audio. Defaults to the global fetch. */
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Mic audio of a follow-up run (default: 3 s of silence). */
  followUpAudio?: Buffer;
  /**
   * The Echo's wake sound as the mic hears it, in dBFS (unset: none). hassmic
   * plays it as every run starts streaming (sound_request, then
   * pipeline_start), so the live audio after the lead-in opens with ~650 ms
   * of it; real Echo recordings (2026-11-18) show it at
   * about -30..-50 dBFS. Cortecho's follow-up guard is built around it.
   */
  wakeSoundDbfs?: number;
  /** Room noise level in dBFS for the audio after the request (unset: digital silence). Real Echo: ~-60. */
  roomNoiseDbfs?: number;
  /**
   * hassmic's experimental "end_of_request" setting (off by default, as on
   * the real Echo): on = the Echo sends end-of-audio after the request;
   * off = it keeps streaming the room until the app ends listening.
   */
  endOfRequest?: boolean;
  wakeWordPhrase?: string;
  /** hassmic's node name (DeviceInfoResponse name and the hello name). */
  nodeName?: string;
  /** MAC address in the DeviceInfoResponse (and, colon-less, the Noise hello). */
  macAddress?: string;
  esphomeVersion?: string;
  model?: string;
  projectName?: string;
  projectVersion?: string;
  manufacturer?: string;
  friendlyName?: string;
  /** DeviceInfoResponse field 5 (hassmic's BUILD_TIME); omitted when empty. */
  buildTime?: string;
  /** HelloResponse server info ("hassmic <VERSION>"). */
  serverInfo?: string;
  /**
   * hassmic's MAX_CLIENTS. Unit tests set 1 to prove a caller never opens two
   * connections to one Echo at the same time (a second socket is refused).
   */
  maxClients?: number;
  /** The DeviceInfo voice assistant feature bits (default: everything hassmic offers). */
  voiceAssistantFlags?: number;
  /**
   * Drop the next N SetKey answers by closing the socket (the request reached
   * the Echo, the answer never came back — a reboot after storing the key).
   */
  loseSetKeyResponses?: number;
  /** With `loseSetKeyResponses`: store the key before dropping (the realistic case). */
  storeKeyWhenLost?: boolean;
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
const LEAD_IN_MS = 800; // hassmic's LEAD_IN_MS
const WAKE_SOUND_MS = 650; // stock ui_wakesound, before a follow-up run
/**
 * Room audio streamed after the request (end_of_request off). Longer than
 * PIPELINE_TIMEOUT: the real Echo never ends a run by running out of audio,
 * only the app's VAD or its own 30 s give up do. (20 s here once ended a long
 * follow-up answer with end-of-audio before Cortecho's 27 s cap was reached.)
 */
const ROOM_MS = 35_000;
const PIPELINE_TIMEOUT_MS = 30_000; // hassmic's PIPELINE_TIMEOUT, per state
const TIME_ASK_MS = 6 * 3600 * 1000; // hassmic's TIME_ASK_MS
const TIMEOUT_TICK_MS = 25;
const ZERO_PSK = Buffer.alloc(32);

/** hassmic's stop words (core_transcript), lower-cased. */
const STOP_WORDS = [
  'stop',
  'stopp',
  'stoppen',
  'stoppa',
  'halt',
  'arrête',
  'arrete',
  'basta',
  'para',
  'pare',
];

type Connection = {
  socket: net.Socket;
  codec: MessageCodec | null;
  keyed: boolean;
};

export class FakeEcho extends EventEmitter<FakeEchoEvents> {
  private server: net.Server | null = null;
  private readonly connections = new Set<Connection>();
  private va: Connection | null = null;
  private readonly options: Required<
    Omit<
      FakeEchoOptions,
      | 'apiKey'
      | 'timing'
      | 'playedDelayMs'
      | 'realtime'
      | 'pipelineTimeoutMs'
      | 'wakeSoundDbfs'
      | 'roomNoiseDbfs'
    >
  > & { apiKey: Buffer | null };
  /** How many SetKey answers are still to be lost (mutable for tests). */
  private setKeyLossesLeft: number;
  /** SetKey requests seen (including the lost ones). */
  setKeyRequests = 0;
  /** Connections accepted since start (hassmic's MAX_CLIENTS slots). */
  connectionsAccepted = 0;
  /** The most connections that were open at the same time (1 = never two). */
  maxOpenConnections = 0;
  /** hassmic's `cancelled` 0/1/2: 1 after a cancel, 2 after the next start. */
  private cancelled: 0 | 1 | 2 = 0;
  private timeAsked = 0;
  private continueConversation = false;
  private ttsUrl = '';
  private ttsExpected = false;
  private micOpen = false;
  private mediaBusy = false;
  private stateSinceMs = Date.now();
  private timeoutTimer: NodeJS.Timeout | null = null;

  /** Every VA event the app sent, in order (dropped aborted-run events excluded). */
  readonly events: ReceivedEvent[] = [];
  /** Every message the app sent (all connections). */
  readonly received: ApiMessage[] = [];
  /** Media the Echo fetched and played. */
  readonly played: PlayedMedia[] = [];
  /** GetTimeResponses, and whether they came over a keyed link (only those set hassmic's clock). */
  readonly timeAnswers: { epochSeconds: number; timezone: string; keyed: boolean }[] = [];
  /** Announcements requested, with what the Echo answered. */
  readonly announcements: { mediaId: string; text: string; success: boolean }[] = [];
  /** hassmic-style log lines, in order (F23). */
  readonly echoLog: string[] = [];
  /** VA events that arrived for a run after it was aborted (hassmic drops them; should stay 0). */
  eventsAfterAbort = 0;
  /** Error sounds played (any ERROR code but the quiet ones, or a refused run). */
  errorSounds = 0;
  /** Runs started (wake word and follow-ups). */
  runs = 0;
  /** The last run gave up after PIPELINE_TIMEOUT. */
  timedOut = false;
  /** The last run was cancelled (button / stop word). */
  aborted = false;
  state: EchoState = 'idle';
  port = 0;
  /** The current timing mode. */
  readonly timing: 'real' | 'fast';
  /** Give up after this long in LISTENING or THINKING (mutable for tests). */
  pipelineTimeoutMs: number;
  /** How the Echo downloads media; tests point it at the app (`createTestRuntime().fetchAudio`). */
  fetchAudio: (url: string) => Promise<Buffer>;
  /** Mic audio of the next follow-up run. */
  followUpAudio: Buffer;
  /** See FakeEchoOptions.endOfRequest. */
  endOfRequest: boolean;
  private readonly realtime: boolean;
  private readonly playedDelayMs: number | null;
  /** The current run's number: a run's mic loop stops once a newer run starts (one mic, one stream). */
  private runGeneration = 0;
  /** Audio spoken into the open run (an answer): it replaces the room audio, chunk by chunk. */
  private injected: Buffer[] = [];
  /** Ends the reply's playback early (barge-in); null when nothing plays. */
  private cutPlayback: (() => void) | null = null;
  /** The request of a barge-in, started once the cut reply has stopped. */
  private pendingBarge: Buffer | null = null;
  /** The reply is being stopped without a new run (the button while SPEAKING). */
  private stopRequested = false;
  /** Between a reply's end and the run that follows it (follow-up, barge-in). */
  private nextRunStarting = false;
  private readonly wakeSoundGapMs: number;
  private readonly wakeSoundDbfs: number | null;
  private readonly roomNoiseDbfs: number | null;

  constructor(options: FakeEchoOptions = {}) {
    super();
    const timing = options.timing ?? 'fast';
    this.timing = timing;
    this.realtime = timing === 'real' ? true : (options.realtime ?? false);
    this.playedDelayMs = timing === 'real' ? null : (options.playedDelayMs ?? 20);
    this.wakeSoundDbfs = options.wakeSoundDbfs ?? null;
    this.roomNoiseDbfs = options.roomNoiseDbfs ?? null;
    // With the sound in the mic stream it plays during the run, as on the Echo; without it, a gap stands in for it.
    this.wakeSoundGapMs = timing === 'real' && this.wakeSoundDbfs === null ? WAKE_SOUND_MS : 0;
    this.pipelineTimeoutMs = options.pipelineTimeoutMs ?? PIPELINE_TIMEOUT_MS;
    this.options = {
      port: 0,
      bind: '127.0.0.1',
      apiKey: null,
      fetchAudio: defaultFetch,
      followUpAudio: Buffer.alloc(MIC_RATE * 2 * 3),
      endOfRequest: false,
      wakeWordPhrase: 'Computer',
      nodeName: 'fake-echo',
      macAddress: '02:00:00:00:00:01',
      esphomeVersion: '2025.5.0',
      model: 'Echo Dot 2 (biscuit)',
      projectName: 'hassmic.echo-dot-2',
      projectVersion: 'test',
      manufacturer: 'Amazon',
      friendlyName: '',
      buildTime: '',
      serverInfo: 'hassmic test',
      maxClients: 4,
      voiceAssistantFlags:
        VA_FEATURE.VOICE_ASSISTANT |
        VA_FEATURE.API_AUDIO |
        VA_FEATURE.TIMERS |
        VA_FEATURE.ANNOUNCE |
        VA_FEATURE.START_CONVERSATION,
      loseSetKeyResponses: 0,
      storeKeyWhenLost: false,
      ...options,
    };
    this.fetchAudio = this.options.fetchAudio;
    this.followUpAudio = this.options.followUpAudio;
    this.endOfRequest = this.options.endOfRequest;
    this.setKeyLossesLeft = this.options.loseSetKeyResponses;
  }

  get apiKey(): Buffer | null {
    return this.options.apiKey;
  }

  /**
   * Replace the stored key. Only the e2e control server calls this, to put the
   * simulator back into a known state between scenarios; nothing in Cortecho
   * ever changes an Echo's key except the adoption SetKey (AGENTS.md).
   */
  setApiKey(key: Buffer | null): void {
    this.options.apiKey = key;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.listen(this.options.port, this.options.bind, () => {
        this.port = (server.address() as net.AddressInfo).port;
        this.ensureTimeoutTimer();
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
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

  /** Connections open right now (the tests assert the app never holds two). */
  get openConnections(): number {
    return this.connections.size;
  }

  eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }

  clear(): void {
    this.events.length = 0;
    this.received.length = 0;
    this.played.length = 0;
    this.announcements.length = 0;
    this.echoLog.length = 0;
    this.timeAnswers.length = 0;
    this.eventsAfterAbort = 0;
    this.errorSounds = 0;
    this.runs = 0;
    this.timedOut = false;
    this.aborted = false;
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
   * A wake word run: request, the lead-in (real timing), then the mic audio,
   * then end-of-audio. Stops streaming when the app ends listening
   * (STT_VAD_END / STT_END / ERROR).
   */
  async runPipeline(pcm: Buffer): Promise<void> {
    const va = this.va;
    if (!va) throw new Error('no voice assistant subscriber');
    this.runs += 1;
    const generation = ++this.runGeneration;
    this.injected = [];
    // hassmic's start(): a cancelled run becomes "dropped until RUN_START".
    if (this.cancelled) this.cancelled = 2;
    this.continueConversation = false;
    this.timedOut = false;
    this.aborted = false;
    this.micOpen = true;
    this.setState('listening');
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
    if (this.timing === 'real') this.sendLeadIn(va);
    // Without end_of_request the mic keeps streaming the (quiet) room after
    // the request until the app ends listening; 20 s at most here.
    const room = roomAudio(MIC_RATE * 2 * (ROOM_MS / 1000), this.roomNoiseDbfs);
    // Every run's live audio opens with the Echo's own wake sound: hassmic
    // plays it as the run starts (sound_request, then pipeline_start), for a
    // wake word, a barge-in and a follow-up alike (incident 2026-11-19, turns
    // 184/185: the chime in every upload). Words spoken into the run
    // (feedAudio) can only follow it.
    const sound = this.wakeSoundDbfs !== null ? wakeSound(this.wakeSoundDbfs, this.roomNoiseDbfs) : null;
    const parts = sound ? [sound, pcm] : [pcm];
    const stream = this.endOfRequest ? Buffer.concat(parts) : Buffer.concat([...parts, room]);
    const injectFrom = sound?.length ?? 0;
    const current = () => this.micOpen && generation === this.runGeneration;
    for (let offset = 0; offset < stream.length && current(); offset += MIC_CHUNK_BYTES) {
      if (va.socket.destroyed) return;
      // One mic: words spoken into the run (feedAudio) take the place of the room.
      const data =
        (offset >= injectFrom ? this.injected.shift() : undefined) ??
        stream.subarray(offset, offset + MIC_CHUNK_BYTES);
      this.sendTo(va, MSG.VOICE_ASSISTANT_AUDIO, encodeVoiceAssistantAudio({ data }));
      const chunkMs = (MIC_CHUNK_BYTES / 2 / MIC_RATE) * 1000;
      await sleep(this.realtime ? chunkMs : 1);
    }
    if (current() && !va.socket.destroyed) {
      // The Echo heard the end of the request itself (micend): end-of-audio.
      this.micOpen = false;
      this.sendTo(va, MSG.VOICE_ASSISTANT_AUDIO, encodeVoiceAssistantAudio({ end: true }));
      if (this.state === 'listening') this.setState('thinking');
    }
  }

  /** The action button / "Computer, stop" while listening or thinking: start=false alone (cancel()). */
  abort(): void {
    if (!this.va) return;
    this.cancel();
  }

  /**
   * The Echo's mic keeps capturing: stream `pcm` into the open run. The smoke
   * suite uses this to speak an answer into a follow-up run (spec §7.1
   * `answer`); the wake word path is `runPipeline`.
   */
  async feedAudio(pcm: Buffer): Promise<void> {
    if (!this.va || !this.micOpen) return;
    // The run's own mic loop sends these in place of the room audio, at the
    // mic's pace; this waits until they are all out (or the mic closed).
    const generation = this.runGeneration;
    for (let offset = 0; offset < pcm.length; offset += MIC_CHUNK_BYTES) {
      this.injected.push(pcm.subarray(offset, offset + MIC_CHUNK_BYTES));
    }
    while (this.injected.length > 0 && this.micOpen && generation === this.runGeneration) await sleep(5);
  }

  /**
   * The wake word during a reply (main.c, local wake while SPEAKING): the
   * reply is cut, and once playback has stopped the wake sound plays and a new
   * run starts with `pcm` as its request. Only while a reply plays.
   */
  bargeIn(pcm: Buffer): boolean {
    if (this.state !== 'speaking' || this.pendingBarge) return false;
    this.log('barge-in');
    this.pendingBarge = pcm;
    // Still downloading: playback is skipped when it would start (playDuration).
    this.cutPlayback?.();
    return true;
  }

  /** The action button while a reply plays: the reply stops, nothing follows. */
  stopPlayback(): boolean {
    if (this.state !== 'speaking') return false;
    this.log('stop: reply cut');
    this.stopRequested = true;
    this.continueConversation = false;
    this.cutPlayback?.();
    return true;
  }

  /** Playing, or about to start the run that follows a reply: not idle for good yet. */
  get busy(): boolean {
    return this.mediaBusy || this.nextRunStarting;
  }

  // -------------------------------------------------------------------------

  private log(line: string): void {
    this.echoLog.push(line);
  }

  /** hassmic's cancel(): start=false alone, the run's later events dropped. */
  private cancel(): void {
    this.micOpen = false;
    this.aborted = true;
    if (this.va && !this.va.socket.destroyed) {
      this.sendTo(this.va, MSG.VOICE_ASSISTANT_REQUEST, encodeVoiceAssistantRequest({ start: false }));
    }
    this.cancelled = 1;
    this.continueConversation = false;
    this.setState('idle');
  }

  /** core_pipeline_finish: end the run, stop() when the mic is still streaming. */
  private finishPipeline(): void {
    this.continueConversation = false;
    if (this.micOpen && this.va && !this.va.socket.destroyed) {
      this.micOpen = false;
      this.sendTo(this.va, MSG.VOICE_ASSISTANT_AUDIO, encodeVoiceAssistantAudio({ end: true }));
      this.sendTo(this.va, MSG.VOICE_ASSISTANT_REQUEST, encodeVoiceAssistantRequest({ start: false }));
    }
    this.micOpen = false;
    this.setState('idle');
  }

  private setState(state: EchoState): void {
    if (state === this.state) return;
    this.state = state;
    this.stateSinceMs = Date.now();
  }

  /** hassmic's lead_in(): 800 ms of zeros, sent at once. */
  private sendLeadIn(conn: Connection): void {
    const bytes = Math.round((LEAD_IN_MS / 1000) * MIC_RATE) * 2;
    const zero = Buffer.alloc(bytes);
    for (let offset = 0; offset < zero.length; offset += MIC_CHUNK_BYTES) {
      this.sendTo(
        conn,
        MSG.VOICE_ASSISTANT_AUDIO,
        encodeVoiceAssistantAudio({ data: zero.subarray(offset, offset + MIC_CHUNK_BYTES) }),
      );
    }
  }

  private ensureTimeoutTimer(): void {
    if (this.timeoutTimer) return;
    this.timeoutTimer = setInterval(() => this.checkTimeout(), TIMEOUT_TICK_MS);
    this.timeoutTimer.unref();
  }

  /** hassmic's PIPELINE_TIMEOUT: give up after too long in one listening/thinking state. */
  private checkTimeout(): void {
    if (this.state !== 'listening' && this.state !== 'thinking') return;
    if (Date.now() - this.stateSinceMs <= this.pipelineTimeoutMs) return;
    this.log('pipeline timeout');
    this.timedOut = true;
    this.finishPipeline();
  }

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
    if (this.connections.size >= this.options.maxClients) {
      socket.destroy(); // hassmic: MAX_CLIENTS
      return;
    }
    const conn: Connection = { socket, codec: null, keyed: false };
    this.connections.add(conn);
    this.connectionsAccepted += 1;
    this.maxOpenConnections = Math.max(this.maxOpenConnections, this.connections.size);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections.delete(conn);
      if (this.va === conn) {
        // The voice assistant's client left: pipelines end.
        this.va = null;
        this.micOpen = false;
        this.setState('idle');
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
            const hello = Buffer.concat([Buffer.from([1]), this.serverHello()]);
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

  /** hassmic's Noise server hello: 0x01, node name \0, mac (no colons) \0. */
  private serverHello(): Buffer {
    return Buffer.from(`${this.options.nodeName}\x00${macPlain(this.options.macAddress)}\x00`, 'latin1');
  }

  private onMessage(conn: Connection, message: ApiMessage): void {
    this.received.push(message);
    this.emit('message', message);
    const { type, payload } = message;
    // hassmic's handle(): once the device has a key, a connection that set up
    // before it (zero PSK, not keyed) is closed on its next message.
    if (this.options.apiKey && !conn.keyed && type !== MSG.DISCONNECT_REQUEST) {
      this.log('encryption: closing a connection without the key');
      conn.socket.destroy();
      return;
    }
    switch (type) {
      case MSG.HELLO_REQUEST:
        this.sendTo(
          conn,
          MSG.HELLO_RESPONSE,
          encodeHelloResponse(this.options.nodeName, this.options.serverInfo),
        );
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
            macAddress: this.options.macAddress,
            esphomeVersion: this.options.esphomeVersion,
            model: this.options.model,
            projectName: this.options.projectName,
            projectVersion: this.options.projectVersion,
            manufacturer: this.options.manufacturer,
            friendlyName: this.options.friendlyName || this.defaultFriendlyName(),
            ...(this.options.buildTime ? { buildTime: this.options.buildTime } : {}),
            voiceAssistantFeatureFlags: this.options.voiceAssistantFlags,
            apiEncryptionSupported: true,
            // No key set yet: Home Assistant may provision one.
            ...(this.options.apiKey ? {} : { provisionable: true }),
          }),
        );
        return;
      case MSG.LIST_ENTITIES_REQUEST:
        // hassmic answers with a media player entity + settings entities; the
        // app never subscribes to states, so a bare "done" is enough here.
        this.sendTo(conn, MSG.LIST_ENTITIES_DONE, encodeEmpty());
        return;
      case MSG.SUBSCRIBE_STATES:
        this.askTime(true);
        return;
      case MSG.PING_REQUEST:
        this.sendTo(conn, MSG.PING_RESPONSE, encodeEmpty());
        // hassmic asks for the time on the first ping (then every 6 h).
        this.askTime(false);
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
        if (subscribe && this.va && this.va !== conn) {
          this.log('voice assistant: a second client tried to subscribe, ignored');
          return;
        }
        // Only the current voice assistant client may unsubscribe.
        if (!subscribe && this.va !== conn) return;
        this.log(`voice assistant: ${subscribe ? 'subscribed' : 'unsubscribed'}`);
        this.va = subscribe ? conn : null;
        if (!subscribe) this.ttsExpected = false;
        return;
      }
      case MSG.VOICE_ASSISTANT_RESPONSE:
        if (decodeVoiceAssistantResponse(payload).error) {
          this.log('pipeline refused');
          this.errorSounds += 1;
          this.setState('idle');
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
        this.setKeyRequests += 1;
        const key = Buffer.from(new ProtoMessage(payload).string(1), 'base64');
        const ok = conn.codec instanceof NoiseTransportCodec && key.length === 32;
        const lose = this.setKeyLossesLeft > 0;
        if (lose) this.setKeyLossesLeft -= 1;
        // A lost answer: hassmic may already have written state/api_key, then the
        // Echo restarted. The client must not assume either way.
        if (ok && (!lose || this.options.storeKeyWhenLost)) {
          this.options.apiKey = key;
          conn.keyed = true;
        }
        if (lose) {
          this.log('set-key: answer lost');
          conn.socket.destroy();
          return;
        }
        this.sendTo(conn, MSG.NOISE_ENCRYPTION_SET_KEY_RESPONSE, new ProtoWriter().bool(1, ok).finish());
        return;
      }
    }
  }

  private defaultFriendlyName(): string {
    return `Echo Dot 2 ${macPlain(this.options.macAddress).slice(-6)}`;
  }

  /** hassmic's ask_time(): first ping, then every 6 h; force on SUBSCRIBE_STATES. */
  private askTime(force: boolean): void {
    if (!force && this.timeAsked && Date.now() - this.timeAsked < TIME_ASK_MS) return;
    this.timeAsked = Date.now();
    if (this.va) this.sendTo(this.va, MSG.GET_TIME_REQUEST, encodeEmpty());
    else for (const conn of this.connections) this.sendTo(conn, MSG.GET_TIME_REQUEST, encodeEmpty());
  }

  private onEvent({ type, data }: { type: number; data: VaEventData }): void {
    // hassmic drops what the app still reports of an aborted run, until the next RUN_START.
    if (
      this.cancelled === 1 ||
      (this.cancelled === 2 && type !== VA_EVENT.RUN_START && type !== VA_EVENT.ERROR)
    ) {
      this.eventsAfterAbort += 1;
      return;
    }
    if (type === VA_EVENT.RUN_START || type === VA_EVENT.ERROR) this.cancelled = 0;
    // Streaming TTS: the URL is known from RUN_START, fetched early on INTENT_PROGRESS.
    if (data.url) this.ttsUrl = data.url;
    const name = VA_EVENT_NAMES[type] ?? String(type);
    const event = { type: name, data };
    this.events.push(event);
    switch (type) {
      case VA_EVENT.STT_START:
        this.setState('listening');
        break;
      case VA_EVENT.STT_VAD_END:
      case VA_EVENT.STT_END: {
        if (type === VA_EVENT.STT_END) {
          const text = data.text ?? data.message ?? '';
          this.log(`transcript: ${text}`);
          if (this.isStopWord(text)) {
            // core_transcript: a stop word cancels the run, nothing plays.
            this.log('stop: pipeline dropped');
            this.cancel();
            break;
          }
        }
        this.micOpen = false;
        if (this.state === 'listening') this.setState('thinking');
        break;
      }
      case VA_EVENT.INTENT_END:
        this.continueConversation = data.continue_conversation === '1';
        break;
      case VA_EVENT.TTS_START:
        this.log(`reply: ${data.text ?? ''}`);
        break;
      case VA_EVENT.TTS_END:
        this.maybePlayReply();
        break;
      case VA_EVENT.INTENT_PROGRESS:
        // Only an early fetch with streaming TTS; a non-streaming reply plays on TTS_END.
        if (data.tts_start_streaming === '1') this.maybePlayReply();
        break;
      case VA_EVENT.RUN_END:
        if (!this.ttsExpected && this.state !== 'speaking') {
          this.finishPipeline();
        } else if (!this.mediaBusy && this.state !== 'speaking') {
          this.setState('idle');
        }
        break;
      case VA_EVENT.ERROR:
        this.micOpen = false;
        if (data.code === 'stt-no-text-recognized') {
          this.log('pipeline: nothing said');
        } else if (data.code === 'duplicate_wake_up_detected') {
          this.log('pipeline: another satellite answers');
        } else {
          this.log(`pipeline error: ${data.text ?? data.code ?? ''}`);
          this.errorSounds += 1;
        }
        if (this.state !== 'speaking') this.setState('idle');
        break;
    }
    this.emit('event', event);
  }

  /** hassmic's core_transcript stop-word check: lower-case, no spaces/punct, wake word stripped. */
  private isStopWord(text: string): boolean {
    const word = normalize(text);
    if (!word) return false;
    const wake = normalize(this.options.wakeWordPhrase);
    const bare = wake && word.startsWith(wake) ? word.slice(wake.length) : word;
    return STOP_WORDS.includes(bare);
  }

  private async playReply(url: string): Promise<void> {
    if (this.mediaBusy) return;
    this.mediaBusy = true;
    this.setState('speaking');
    const media = await this.fetchMedia(url, 'reply');
    await this.playDuration(media);
    this.mediaBusy = false;
    this.ttsExpected = false;
    if (this.cancelled) return;
    // Replies go through the announcement path in hassmic, so they end with AnnounceFinished.
    if (this.va) this.sendTo(this.va, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(true));
    this.setState('idle');
    this.played.push(media);
    this.emit('played', media);
    const barge = this.pendingBarge;
    this.pendingBarge = null;
    this.stopRequested = false;
    if (barge && this.va) {
      // core_pipeline_finish after a local barge-in: wake sound, then a wake word run.
      this.continueConversation = false;
      this.nextRunStarting = true;
      await sleep(WAKE_SOUND_MS);
      this.nextRunStarting = false;
      void this.runPipeline(barge);
      return;
    }
    if (this.continueConversation && this.va) {
      // core_pipeline_finish with barge_in: wake sound, then a new run without the wake word.
      this.continueConversation = false;
      this.nextRunStarting = true;
      if (this.wakeSoundGapMs > 0) await sleep(this.wakeSoundGapMs);
      this.nextRunStarting = false;
      void this.runPipeline(this.followUpAudio);
    }
  }

  /** Fetch the reply URL once (TTS_END, or INTENT_PROGRESS with streaming TTS). */
  private maybePlayReply(): void {
    if (this.ttsUrl && !this.ttsExpected) {
      this.ttsExpected = true;
      this.micOpen = false;
      void this.playReply(this.ttsUrl);
    }
  }

  private async onAnnounce(
    conn: Connection,
    req: { mediaId: string; text: string; preannounceMediaId: string; startConversation: boolean },
  ): Promise<void> {
    if (this.mediaBusy) {
      this.announcements.push({ mediaId: req.mediaId, text: req.text, success: false });
      this.sendTo(conn, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(false));
      return;
    }
    this.mediaBusy = true;
    this.setState('speaking');
    let success = true;
    if (req.preannounceMediaId) {
      const pre = await this.fetchMedia(req.preannounceMediaId, 'announcement');
      await this.playDuration(pre);
      success = pre.format === 'wav' || pre.format === 'mp3';
    }
    const media = await this.fetchMedia(req.mediaId, 'announcement');
    await this.playDuration(media);
    success = success && (media.format === 'wav' || media.format === 'mp3');
    this.mediaBusy = false;
    this.setState('idle');
    this.announcements.push({ mediaId: req.mediaId, text: req.text, success });
    this.played.push(media);
    this.sendTo(conn, MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED, encodeAnnounceFinished(success));
    this.emit('played', media);
    if (success && req.startConversation && this.va) {
      if (this.wakeSoundGapMs > 0) await sleep(this.wakeSoundGapMs);
      void this.runPipeline(this.followUpAudio);
    }
  }

  /** Playback delay: the WAV's real length in 'real' timing, else the fixed delay. */
  private async playDuration(media: PlayedMedia): Promise<void> {
    const ms =
      this.playedDelayMs ??
      (media.format === 'wav' && media.sampleRate > 0
        ? Math.round((media.bytes / media.sampleRate / 2) * 1000)
        : 0);
    if (this.pendingBarge || this.stopRequested) return; // cut before it started
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.cutPlayback = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.cutPlayback = null;
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

/** Lower-case, spaces and punctuation stripped, as hassmic's core_transcript reads a transcript. */
function normalize(text: string): string {
  let out = '';
  for (const char of text) {
    if (' \t.,!?¡¿"\''.includes(char)) continue;
    out += char.toLowerCase();
  }
  return out;
}

/** "aabbccddeeff": the MAC without colons, lower-cased (the Noise server hello). */
function macPlain(macAddress: string): string {
  return macAddress.replace(/:/g, '').toLowerCase();
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

/** `bytes` of room: noise at `dbfs`, or digital silence when unset. */
function roomAudio(bytes: number, dbfs: number | null): Buffer {
  const out = Buffer.alloc(bytes);
  if (dbfs === null) return out;
  // Uniform noise: RMS = peak / sqrt(3).
  const peak = 32768 * 10 ** (dbfs / 20) * Math.sqrt(3);
  for (let i = 0; i + 1 < bytes; i += 2) out.writeInt16LE(Math.round((Math.random() * 2 - 1) * peak), i);
  return out;
}

/** The wake sound as the mic hears it: a decaying two-tone chime over the room, WAKE_SOUND_MS long. */
function wakeSound(dbfs: number, roomDbfs: number | null): Buffer {
  const samples = Math.round((MIC_RATE * WAKE_SOUND_MS) / 1000);
  const out = roomAudio(samples * 2, roomDbfs);
  const amplitude = 32768 * 10 ** (dbfs / 20) * Math.SQRT2;
  for (let i = 0; i < samples; i++) {
    const t = i / MIC_RATE;
    const frequency = t < 0.2 ? 880 : 1320;
    const envelope = Math.exp(-3 * (i / samples));
    const value = out.readInt16LE(i * 2) + amplitude * envelope * Math.sin(2 * Math.PI * frequency * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
}
