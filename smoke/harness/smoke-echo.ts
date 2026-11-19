import type { DeviceStatus, Turn } from '@cortecho/shared';
import { FakeEcho } from '../../apps/api/src/esphome/fake-echo.ts';
import { parseApiKey } from '../../apps/api/src/esphome/noise.ts';
import { pcmToWav } from '../../apps/api/src/pipeline/audio.ts';
import { type Cleanup, createCleanup } from './cleanup.ts';
import { CortechoApi } from './cortecho-api.ts';
import { loadEnv, type SmokeEnv } from './env.ts';
import { newRunId, Report } from './report.ts';
import { ServerLog } from './server-log.ts';
import { OwnerVoice, type WakeInput, withRealWavLengths } from './voice.ts';

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

/** The Echo's wake sound in its own mic (real recordings: -30..-50 dBFS). */
const WAKE_SOUND_DBFS = -38;
/** A person answers a beep after a moment, not inside it. */
const ANSWER_REACTION_MS = 1000;

/** The smoke Echo if one exists (for the report hook in the setup file). */
export function currentSmokeEcho(): SmokeEcho | null {
  return instance;
}

/** The shared smoke Echo (setup on first use, reused by later files). */
export function useSmokeEcho(): SmokeEcho {
  instance ??= new SmokeEcho();
  return instance;
}

export class SmokeEcho {
  readonly runId: string;
  /**
   * The run id as two plain words ("amber falcon"), for anything spoken: TTS
   * reads the run id itself as a string of digits that nobody can search for.
   * Side effects carry it (§6.4) so the result can be found and cleaned up.
   */
  readonly tag: string;
  readonly env: SmokeEnv;
  readonly report: Report;
  readonly voice: OwnerVoice;
  readonly cleanup: Cleanup;
  private readonly api: CortechoApi;
  private readonly log: ServerLog;
  private readonly echo: FakeEcho;
  private deviceId: number | null = null;
  /** Set up once per run; later files reuse the connected Test Echo (spec §6.1). */
  private ready = false;
  /** hassmic asks the time once per 6 h (process-wide), so only the first connect is checked. */
  private timeChecked = false;
  private turnCount = 0;
  private stepCount = 0;
  private lastReplyWav: Buffer | null = null;
  /** The mirrored prompt + overrides, restored in afterEach. */
  private mirrored: { prompt: string; overrides: Record<string, unknown> } = { prompt: '', overrides: {} };

  constructor() {
    this.env = loadEnv();
    this.runId = newRunId();
    this.tag = speakableTag(this.runId);
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
      // The mic as on the real Echo (levels measured from its follow-up audio,
      // 2026-11-18): the wake sound opens every run, the room is never
      // digital silence, and a follow-up hears only the room until a test speaks.
      wakeSoundDbfs: WAKE_SOUND_DBFS,
      roomNoiseDbfs: this.env.SMOKE_ROOM_DBFS,
      followUpAudio: Buffer.alloc(0),
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
    // Once per run: every scenario file calls setup, the first one does it and
    // later files reuse the connected Test Echo (files share one worker).
    if (this.ready) return;

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
    this.ready = true;
  }

  /**
   * afterAll of every file: writes report.md so far. The Test Echo stays up for
   * the next file; Vitest has no "last file" hook in the worker, so the run's
   * end is globalSetup's teardown, which disables the device over HTTP (§6.3).
   * The simulator's socket closes when the worker exits.
   */
  async teardown(): Promise<void> {
    this.report.finish();
  }

  /** beforeEach: forget the conversation and clear the simulator's records. */
  async newConversation(): Promise<void> {
    // A previous test may have left a follow-up open: press the button, as the
    // owner would, and wait for the Echo to be idle before forgetting.
    if (this.echo.state === 'speaking') this.echo.stopPlayback();
    else if (this.echo.state !== 'idle') this.echo.abort();
    await this.settleIdle();
    // After a dropped link (dropLink), Cortecho reconnects on its own: wait for it.
    if (this.deviceId !== null && !this.echo.isSubscribed) await this.waitUntilConnected(this.deviceId);
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
    await this.settle(1);
    return this.observe(startedAt, 0, 'wake', pcm);
  }

  /**
   * Speaks into the follow-up run Cortecho opened; fails if none is open.
   * `afterMs`: how long after the run opened the person starts (the wake sound
   * plays first), 1 s by default.
   */
  async answer(
    text: string,
    { afterMs = ANSWER_REACTION_MS }: { afterMs?: number } = {},
  ): Promise<TurnObservation> {
    this.guardTurn();
    if (this.echo.state !== 'listening') throw new Error('no follow-up run is open to answer');
    const opened = this.echo.runs;
    if (afterMs > 0) await sleep(afterMs);
    if (this.echo.state !== 'listening' || this.echo.runs !== opened) {
      throw new Error(`the follow-up closed before the answer (state ${this.echo.state})`);
    }
    const startedAt = new Date();
    const marker = this.echo.events.length;
    this.lastReplyWav = null;
    const runs = this.echo.runs;
    const pcm = await this.voice.micPcm(text);
    await this.echo.feedAudio(pcm);
    await this.settle(runs);
    return this.observe(startedAt, marker, 'answer', pcm);
  }

  /** Lets the follow-up run hear only the room (expects a quiet end). */
  async stayQuiet(): Promise<TurnObservation> {
    const startedAt = new Date();
    const marker = this.echo.events.length;
    this.lastReplyWav = null;
    await this.settle(this.echo.runs);
    return this.observe(startedAt, marker, 'quiet');
  }

  /** The action button: start=false alone while listening or thinking. */
  pressButton(): void {
    this.echo.abort();
  }

  /**
   * The wake word during a reply (hassmic, local wake while SPEAKING): waits
   * for the reply to start playing, `afterMs` into it cuts it, and the new
   * run's request is `text`. Start the first request with `wake()` without
   * awaiting it, then call this.
   */
  async bargeIn(text: string, { afterMs = 0 }: { afterMs?: number } = {}): Promise<TurnObservation> {
    this.guardTurn();
    const pcm = await this.voice.micPcm(text);
    await this.waitFor(() => this.echo.state === 'speaking', 90_000, 'a reply to start playing');
    if (afterMs > 0) await sleep(afterMs);
    const startedAt = new Date();
    const marker = this.echo.events.length;
    const runs = this.echo.runs;
    this.lastReplyWav = null;
    if (!this.echo.bargeIn(pcm)) throw new Error(`no reply was playing to cut (state ${this.echo.state})`);
    await this.waitFor(() => this.echo.runs > runs, 10_000, 'the barge-in run to start');
    await this.settle(runs + 1);
    return this.observe(startedAt, marker, 'barge-in', pcm);
  }

  /** The Echo rebooting / Wi-Fi dropping, at the current pipeline state. */
  async dropLink({
    during = 'thinking',
  }: {
    during?: 'listening' | 'thinking' | 'speaking';
  } = {}): Promise<void> {
    await this.waitFor(() => this.echo.state === during, 60_000, `the Echo to be ${during}`);
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

  /**
   * Waits until the step settles: idle, or a follow-up run opened after the
   * step's own run (`ownRuns`: the run count the step itself reached).
   */
  private async settle(ownRuns: number, timeoutMs = 90_000): Promise<void> {
    await this.waitFor(
      () =>
        (this.echo.state === 'idle' && !this.echo.busy) ||
        (this.echo.state === 'listening' && this.echo.runs > ownRuns),
      timeoutMs,
      'the turn to settle',
    );
  }

  private async waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`timed out waiting for ${what} (state ${this.echo.state})`);
      await sleep(50);
    }
  }

  private async settleIdle(timeoutMs = 30_000): Promise<void> {
    const started = Date.now();
    while (this.echo.state !== 'idle' || this.echo.busy) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`the Echo did not go idle (state ${this.echo.state})`);
      await sleep(100);
    }
  }

  private async observe(
    startedAt: Date,
    fromEventIndex: number,
    kind = 'step',
    inputPcm?: Buffer,
  ): Promise<TurnObservation> {
    let said: string | null = null;
    let transcribeError: string | null = null;
    if (this.lastReplyWav) {
      try {
        said = await this.voice.transcribe(this.lastReplyWav);
      } catch (error) {
        // Never hidden: a failed transcription shows in the report, not as a silent null.
        transcribeError = String(error);
      }
    }
    const turns = this.deviceId !== null ? await this.api.turns(this.deviceId, 1).catch(() => []) : [];
    const events = this.echo.events.slice(fromEventIndex);
    const listensAgain =
      [...events].reverse().find((event) => event.type === 'intent_end')?.data.continue_conversation === '1';
    const observation: TurnObservation = {
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
    this.recordStep(kind, observation, inputPcm, transcribeError);
    return observation;
  }

  /** Spec §8: one folder per step, and the dialogue as heard in report.md. */
  private recordStep(
    kind: string,
    observation: TurnObservation,
    inputPcm: Buffer | undefined,
    transcribeError: string | null,
  ): void {
    this.stepCount += 1;
    const dir = `${String(this.stepCount).padStart(2, '0')}-${kind}`;
    if (inputPcm) this.report.step(`${dir}/in.wav`, pcmToWav(inputPcm, 16_000));
    if (observation.replyWav) this.report.step(`${dir}/reply.wav`, withRealWavLengths(observation.replyWav));
    this.report.step(`${dir}/wire.json`, JSON.stringify(this.echo.events, null, 2));
    this.report.step(`${dir}/turn.json`, JSON.stringify(observation.turn, null, 2));
    this.report.step(`${dir}/server.log`, observation.serverLog.join('\n'));
    this.report.step(`${dir}/echo.log`, observation.echoLog.join('\n'));
    const turn = observation.turn;
    this.report.line(`### ${dir}`);
    this.report.line(`- you said: ${turn?.transcript ? `"${turn.transcript}"` : '(nothing heard)'}`);
    this.report.line(`- Echo said: ${observation.said ? `"${observation.said}"` : '(no reply audio)'}`);
    if (turn?.reply && turn.reply !== observation.said) this.report.line(`- reply text: "${turn.reply}"`);
    if (transcribeError) this.report.line(`- transcription failed: ${transcribeError}`);
    this.report.line(
      `- outcome: ${turn?.outcome ?? '?'}, listens again: ${observation.listensAgain}, ` +
        `wire: ${observation.wire.join(' ')}`,
    );
    if (turn?.timings) this.report.line(`- timings: ${JSON.stringify(turn.timings)}`);
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
        (this.timeChecked || this.echo.timeAnswers.length > 0)
      ) {
        this.timeChecked = true;
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

const TAG_WORDS = [
  'amber',
  'falcon',
  'cobalt',
  'meadow',
  'harbor',
  'violet',
  'granite',
  'willow',
  'copper',
  'lantern',
  'orchid',
  'summit',
  'pepper',
  'glacier',
  'marble',
  'thistle',
];

/** Two words picked from the run id, stable for the run. */
function speakableTag(runId: string): string {
  let hash = 0;
  for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${TAG_WORDS[hash % 16]} ${TAG_WORDS[(hash >>> 4) % 16]}`;
}
