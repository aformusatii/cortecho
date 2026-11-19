import type { DeviceStatus, Turn } from '@cortecho/shared';
import { FakeEcho } from '../../apps/api/src/esphome/fake-echo.ts';
import { parseApiKey } from '../../apps/api/src/esphome/noise.ts';
import { type Cleanup, createCleanup } from './cleanup.ts';
import { CortechoApi } from './cortecho-api.ts';
import { loadEnv, type SmokeEnv } from './env.ts';
import { newRunId, Report } from './report.ts';
import { ServerLog } from './server-log.ts';
import { OwnerVoice, type WakeInput } from './voice.ts';

/**
 * The simulated Echo and the scenario API (spec §6–§7). One singleton per run:
 * the smoke config runs every file in one worker without isolation, so the
 * first file's `beforeAll` runs the setup and later files reuse it (O2).
 */

/** The real Echo's hassmic version (spec §4.2). */
const HASSMIC_VERSION = '2026.11.08.115848';

export type TurnObservation = {
  /** VA event types in order (this step's slice). */
  wire: string[];
  /** INTENT_END continue_conversation=1: the Echo will listen again. */
  listensAgain: boolean;
  errorSound: boolean;
  aborted: boolean;
  timedOut: boolean;
  /** Transcription of the played reply, or null when nothing played. */
  said: string | null;
  replyWav: Buffer | null;
  /** Echo-side timings (wake → STT_VAD_END → TTS_END → played). */
  timings: Record<string, number>;
  /** The turn from GET /api/turns?deviceId=. */
  turn: Turn | null;
  serverLog: string[];
  echoLog: string[];
};

let instance: SmokeEcho | null = null;

/** The shared smoke Echo (setup on first use, reused by later files). */
export function useSmokeEcho(): SmokeEcho {
  instance ??= new SmokeEcho();
  return instance;
}

export class SmokeEcho {
  readonly runId: string;
  readonly env: SmokeEnv;
  readonly report: Report;
  readonly voice: OwnerVoice;
  readonly cleanup: Cleanup;
  private readonly api: CortechoApi;
  private readonly log: ServerLog;
  private readonly echo: FakeEcho;
  private deviceId: number | null = null;
  private refs = 0;
  private turnCount = 0;
  private lastReplyWav: Buffer | null = null;
  /** The mirrored prompt + overrides, restored in afterEach. */
  private mirrored: { prompt: string; overrides: Record<string, unknown> } = { prompt: '', overrides: {} };

  constructor() {
    this.env = loadEnv();
    this.runId = newRunId();
    this.report = new Report(this.runId);
    this.voice = new OwnerVoice(this.env);
    this.cleanup = createCleanup(this.env);
    this.api = new CortechoApi(this.env.SMOKE_CORTECHO_URL);
    this.log = new ServerLog(this.env.SMOKE_CORTECHO_CONTAINER);
    this.echo = new FakeEcho({
      timing: 'real',
      bind: this.env.SMOKE_ECHO_BIND,
      port: this.env.SMOKE_ECHO_PORT,
      apiKey: parseApiKey(this.env.SMOKE_ECHO_API_KEY),
      nodeName: this.env.SMOKE_ECHO_NODE_NAME,
      macAddress: this.env.SMOKE_ECHO_MAC,
      wakeWordPhrase: this.env.SMOKE_ECHO_WAKE_WORD,
      projectVersion: HASSMIC_VERSION,
      friendlyName: `Echo Dot 2 ${this.env.SMOKE_ECHO_MAC.replace(/:/g, '').slice(-6)}`,
      serverInfo: `hassmic ${HASSMIC_VERSION}`,
      fetchAudio: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.lastReplyWav = Buffer.from(await response.arrayBuffer());
        return this.lastReplyWav;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle (spec §6)
  // -------------------------------------------------------------------------

  /** §6.1: env → health → SimEcho → device → lock → mirror → enable → wait. */
  async setup(): Promise<void> {
    // Reference-counted: every scenario file calls setup/teardown once; only the
    // first file sets up and the last tears down (files share one worker).
    this.refs += 1;
    if (this.refs > 1) return;

    // 2. Refuse if the real Echo's pipeline is not idle (the owner is talking).
    const health = await this.api.health();
    const realEcho = health.devices.find(
      (device) => device.name !== this.env.SMOKE_DEVICE_NAME && device.kind === 'echo' && device.enabled,
    );
    if (realEcho && realEcho.pipeline.state !== 'idle') {
      throw new Error(`the real Echo is busy (${realEcho.pipeline.state}); wait for it to be idle`);
    }

    // 3. Start the simulated Echo.
    await this.echo.start();

    // 4. Find the device by host:port; create it once (never deleted).
    const devices = await this.api.listDevices();
    let device = devices.find(
      (candidate) =>
        candidate.host === this.env.SMOKE_ECHO_HOST && candidate.port === this.env.SMOKE_ECHO_PORT,
    );
    if (!device) {
      device = await this.api.createDevice({
        name: this.env.SMOKE_DEVICE_NAME,
        kind: 'echo',
        host: this.env.SMOKE_ECHO_HOST,
        port: this.env.SMOKE_ECHO_PORT,
        apiKey: this.env.SMOKE_ECHO_API_KEY,
        enabled: false,
      });
    }
    this.deviceId = device.id;

    // Run lock: already enabled and connected means another run is in progress.
    if (device.enabled && device.state === 'connected' && !this.env.SMOKE_FORCE) {
      throw new Error('the Test Echo is already connected: another run is in progress (set SMOKE_FORCE=1)');
    }

    // 5. Mirror the real Echo's per-Echo prompt and overrides.
    await this.mirror(devices, device);

    // 6. Enable and wait until connected, encrypted, subscribed and time-answered.
    await this.api.patchDevice(device.id, { enabled: true });
    await this.waitUntilConnected(device.id);
  }

  /** §6.3: disable the Test Echo, stop the simulator, write the report. */
  async teardown(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0) return;
    try {
      if (this.deviceId !== null) await this.api.patchDevice(this.deviceId, { enabled: false });
    } catch {
      // Best effort: globalSetup also disables the device.
    }
    await this.echo.stop();
    this.report.finish();
  }

  /** beforeEach: forget the conversation and clear the simulator's records. */
  async newConversation(): Promise<void> {
    if (this.deviceId !== null) await this.api.resetConversation(this.deviceId);
    this.echo.clear();
    this.lastReplyWav = null;
  }

  /** afterEach: restore the mirrored prompt + overrides (a scenario may have changed them). */
  async restoreMirrored(): Promise<void> {
    if (this.deviceId === null) return;
    const settings = await this.api.deviceSettings(this.deviceId);
    const changes: Record<string, unknown> = {};
    // Clear any override a scenario added.
    for (const key of Object.keys(settings.overrides)) {
      if (!(key in this.mirrored.overrides)) changes[key] = null;
    }
    // Restore the mirrored values.
    for (const [key, value] of Object.entries(this.mirrored.overrides)) changes[key] = value;
    await this.api.patchDeviceSettings(this.deviceId, { version: settings.version, changes });
    await this.api.patchDevice(this.deviceId, { prompt: this.mirrored.prompt });
  }

  /** PATCH /api/devices/:id/settings with per-Echo changes (restored in afterEach). */
  async setDeviceSetting(changes: Record<string, unknown>): Promise<void> {
    if (this.deviceId === null) throw new Error('the Test Echo is not set up');
    const settings = await this.api.deviceSettings(this.deviceId);
    await this.api.patchDeviceSettings(this.deviceId, { version: settings.version, changes });
  }

  // -------------------------------------------------------------------------
  // Primitives (spec §7.1) — one run each unless noted
  // -------------------------------------------------------------------------

  /** A wake-word run: the request spoken as mic audio, the reply played back. */
  async wake(input: WakeInput): Promise<TurnObservation> {
    this.guardTurn();
    const startedAt = new Date();
    const pcm = await this.inputPcm(input);
    this.lastReplyWav = null;
    this.echo.clear();
    await this.echo.runPipeline(pcm);
    await this.settle();
    return this.observe(startedAt, 0);
  }

  /** Speaks into the follow-up run Cortecho opened; fails if none is open. */
  async answer(text: string): Promise<TurnObservation> {
    this.guardTurn();
    if (this.echo.state !== 'listening') throw new Error('no follow-up run is open to answer');
    const startedAt = new Date();
    const marker = this.echo.events.length;
    this.lastReplyWav = null;
    await this.echo.feedAudio(await this.voice.micPcm(text));
    await this.settle();
    return this.observe(startedAt, marker);
  }

  /** Lets the follow-up run hear only the room (expects a quiet end). */
  async stayQuiet(): Promise<TurnObservation> {
    const startedAt = new Date();
    const marker = this.echo.events.length;
    await this.settle();
    return this.observe(startedAt, marker);
  }

  /** The action button: start=false alone while listening or thinking. */
  pressButton(): void {
    this.echo.abort();
  }

  /** The wake word during a reply: cut the playback, start a new run. */
  async bargeIn(text: string, { afterMs = 0 }: { afterMs?: number } = {}): Promise<TurnObservation> {
    this.guardTurn();
    const startedAt = new Date();
    if (afterMs > 0) await sleep(afterMs);
    this.echo.abort();
    const marker = this.echo.events.length;
    this.lastReplyWav = null;
    await this.echo.runPipeline(await this.voice.micPcm(text));
    await this.settle();
    return this.observe(startedAt, marker);
  }

  /** The Echo rebooting / Wi-Fi dropping, at the current pipeline state. */
  dropLink(): void {
    this.echo.dropConnection();
  }

  /** POST /api/say to this Echo (or to all, `@audible`). */
  async announce(text: string, { all = false }: { all?: boolean } = {}): Promise<void> {
    await this.api.say(text, all ? { all: true } : { deviceId: this.deviceId ?? undefined });
  }

  /** Waits, for idle-time behaviour. */
  idle(ms: number): Promise<void> {
    return sleep(ms);
  }

  // -------------------------------------------------------------------------

  private async inputPcm(input: WakeInput): Promise<Buffer> {
    return typeof input === 'string'
      ? this.voice.micPcm(input)
      : this.voice.shapedWav(input.wav, { noiseDb: input.noiseDb });
  }

  /** Counts a voice turn before it starts (cost guard); throws at SMOKE_MAX_TURNS. */
  private guardTurn(): void {
    if (this.env.SMOKE_YES) return;
    if (this.turnCount >= this.env.SMOKE_MAX_TURNS) {
      throw new Error(`reached SMOKE_MAX_TURNS (${this.env.SMOKE_MAX_TURNS}); set SMOKE_YES=1 to continue`);
    }
    this.turnCount += 1;
  }

  /** Waits until the turn settles: idle, or a follow-up opened (listening, second run). */
  private async settle(timeoutMs = 90_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.echo.state === 'idle') return;
      if (this.echo.state === 'listening' && this.echo.runs > 1) return;
      await sleep(100);
    }
    throw new Error(`the turn did not settle (state ${this.echo.state})`);
  }

  private async observe(startedAt: Date, fromEventIndex: number): Promise<TurnObservation> {
    const said = this.lastReplyWav ? await this.voice.transcribe(this.lastReplyWav).catch(() => null) : null;
    const turns = this.deviceId !== null ? await this.api.turns(this.deviceId, 1).catch(() => []) : [];
    const events = this.echo.events.slice(fromEventIndex);
    const listensAgain =
      [...events].reverse().find((event) => event.type === 'intent_end')?.data.continue_conversation === '1';
    return {
      wire: events.map((event) => event.type),
      listensAgain,
      errorSound: this.echo.errorSounds > 0,
      aborted: this.echo.aborted,
      timedOut: this.echo.timedOut,
      said,
      replyWav: this.lastReplyWav,
      timings: {},
      turn: turns[0] ?? null,
      serverLog: await this.log.since(startedAt),
      echoLog: [...this.echo.echoLog],
    };
  }

  private async waitUntilConnected(id: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const devices = await this.api.listDevices();
      const device = devices.find((candidate) => candidate.id === id);
      if (
        device?.state === 'connected' &&
        device.encryption === 'noise' &&
        this.echo.isSubscribed &&
        this.echo.timeAnswers.length > 0
      ) {
        return;
      }
      await sleep(250);
    }
    throw new Error('the Test Echo did not connect, subscribe and answer the time within 15 s');
  }

  /** Copies the real Echo's prompt and per-Echo overrides onto the Test Echo. */
  private async mirror(devices: DeviceStatus[], target: DeviceStatus): Promise<void> {
    const source = devices.find(
      (device) =>
        device.id !== target.id &&
        device.kind === 'echo' &&
        device.enabled &&
        (!this.env.SMOKE_MIRROR_DEVICE || device.name === this.env.SMOKE_MIRROR_DEVICE),
    );
    if (!source) return;
    this.mirrored.prompt = source.prompt;
    const settings = await this.api.deviceSettings(source.id);
    this.mirrored.overrides = settings.overrides;
    if (source.prompt) await this.api.patchDevice(target.id, { prompt: source.prompt });
    if (Object.keys(settings.overrides).length > 0) {
      await this.api.patchDeviceSettings(target.id, {
        version: settings.version,
        changes: settings.overrides,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
