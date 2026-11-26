import { type EchoState, FakeEcho, type PlayedMedia } from '../../apps/api/src/esphome/fake-echo.ts';

/**
 * The Echo process. FakeEcho is the protocol stand-in; this class owns its
 * lifecycle (including a reboot that keeps the key), the media the Echo
 * downloaded, and the run/event history the control API reports.
 */

export type EchoHostOptions = {
  bind: string;
  port: number;
  wakeDb: number;
  roomDb: number;
  nodeName: string;
  friendlyName: string;
  macAddress: string;
  hassmicVersion: string;
};

export type MediaRecord = {
  n: number;
  url: string;
  bytes: Buffer;
  kind: PlayedMedia['kind'] | null;
  format: PlayedMedia['format'] | null;
  sampleRate: number;
  playedBytes: number | null;
  at: string | null;
};

export type RunOutcome = 'answered' | 'no-reply' | 'error' | 'timeout';

export type RunRecord = {
  id: number;
  startedAtMs: number;
  fromEvent: number;
  fromPlayed: number;
  done: boolean;
  outcome: RunOutcome;
  runEnd: boolean;
  error: string | null;
  ms: number;
};

type EventRecord = { type: string; at: number };
type PlayedRecord = {
  n: number;
  kind: PlayedMedia['kind'];
  url: string;
  format: PlayedMedia['format'];
  sampleRate: number;
  bytes: number;
  at: number;
};

export class EchoHost {
  private readonly options: EchoHostOptions;
  private echo: FakeEcho;
  private readonly startedAtMs = Date.now();
  private readonly media: MediaRecord[] = [];
  private readonly playedLog: PlayedRecord[] = [];
  private readonly eventLog: EventRecord[] = [];
  private readonly runs: RunRecord[] = [];
  private runSeq = 0;

  constructor(options: EchoHostOptions) {
    this.options = options;
    this.echo = this.buildEcho(null);
  }

  start(): Promise<number> {
    return this.echo.start();
  }

  async stop(): Promise<void> {
    await this.echo.stop();
  }

  drop(): void {
    this.echo.dropConnection();
  }

  /**
   * A real reboot loses the link but not the key: hassmic stores it on flash.
   * The simulated key lives in this process, so copy it to the new FakeEcho.
   */
  async reboot(): Promise<void> {
    if (this.echo.state !== 'idle' || this.echo.busy) {
      throw new Error(`the Echo is busy (${this.echo.state})`);
    }
    const key = this.echo.apiKey;
    await this.echo.stop();
    this.echo = this.buildEcho(key);
    await this.echo.start();
  }

  /** Starts a wake-word run and returns at once; use `run(id)` to follow it. */
  wake(pcm: Buffer): RunRecord {
    if (!this.echo.isSubscribed) throw new Error('no voice assistant subscriber');
    const run: RunRecord = {
      id: ++this.runSeq,
      startedAtMs: Date.now(),
      fromEvent: this.eventLog.length,
      fromPlayed: this.playedLog.length,
      done: false,
      outcome: 'no-reply',
      runEnd: false,
      error: null,
      ms: 0,
    };
    this.runs.push(run);
    void this.executeRun(run, pcm);
    return run;
  }

  run(id: number): ReturnType<EchoHost['runView']> | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    return run ? this.runView(run) : null;
  }

  state(): Record<string, unknown> {
    const last = this.runs.at(-1);
    const timeAnswers = this.echo.timeAnswers;
    const lastTime = timeAnswers.at(-1);
    return {
      subscribed: this.echo.isSubscribed,
      // FakeEcho refuses plaintext once a key is stored, so a subscribed link
      // with a key can only be the encrypted one.
      encrypted: this.echo.apiKey !== null && this.echo.isSubscribed,
      keyState: this.echo.apiKey ? 'set' : 'none',
      connections: this.echo.openConnections,
      connectionsAccepted: this.echo.connectionsAccepted,
      setKeyRequests: this.echo.setKeyRequests,
      state: this.echo.state satisfies EchoState,
      timeAnswers: {
        count: timeAnswers.length,
        keyed: timeAnswers.some((answer) => answer.keyed),
        last: lastTime ?? null,
      },
      media: this.media.map((item) => this.mediaView(item)),
      played: this.playedLog.map((item) => ({ ...item })),
      events: this.eventLog.slice(-60).map((event) => ({
        type: event.type,
        ms: event.at - this.startedAtMs,
      })),
      runs: this.runs.map((run) => this.runView(run)),
      lastRun: last ? this.runView(last) : null,
    };
  }

  mediaBytes(n: number): Buffer | null {
    return this.media.find((item) => item.n === n)?.bytes ?? null;
  }

  private buildEcho(key: Buffer | null): FakeEcho {
    const echo = new FakeEcho({
      timing: 'real',
      bind: this.options.bind,
      port: this.options.port,
      apiKey: key,
      wakeWordPhrase: 'Computer',
      nodeName: this.options.nodeName,
      macAddress: this.options.macAddress,
      friendlyName: this.options.friendlyName,
      projectVersion: this.options.hassmicVersion,
      serverInfo: `hassmic ${this.options.hassmicVersion}`,
      wakeSoundDbfs: this.options.wakeDb,
      roomNoiseDbfs: this.options.roomDb,
      followUpAudio: Buffer.alloc(0),
      fetchAudio: (url) => this.fetchMedia(url),
    });
    echo.on('event', (event) => this.eventLog.push({ type: event.type, at: Date.now() }));
    echo.on('played', (media) => this.recordPlayed(media));
    return echo;
  }

  private async fetchMedia(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    this.media.push({
      n: this.media.length + 1,
      url,
      bytes,
      kind: null,
      format: null,
      sampleRate: 0,
      playedBytes: null,
      at: null,
    });
    return bytes;
  }

  private recordPlayed(media: PlayedMedia): void {
    let record: MediaRecord | undefined;
    for (let index = this.media.length - 1; index >= 0; index -= 1) {
      const candidate = this.media[index];
      if (candidate && candidate.url === media.url) {
        record = candidate;
        break;
      }
    }
    const at = Date.now();
    if (record) {
      record.kind = media.kind;
      record.format = media.format;
      record.sampleRate = media.sampleRate;
      record.playedBytes = media.bytes;
      record.at = new Date(at).toISOString();
    }
    this.playedLog.push({
      n: record?.n ?? 0,
      kind: media.kind,
      url: media.url,
      format: media.format,
      sampleRate: media.sampleRate,
      bytes: media.bytes,
      at,
    });
  }

  private async executeRun(run: RunRecord, pcm: Buffer): Promise<void> {
    const echo = this.echo;
    try {
      await echo.runPipeline(pcm);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const events = this.eventLog.slice(run.fromEvent);
        const ended = events.some((event) => event.type === 'run_end' || event.type === 'error');
        if (ended && echo.state === 'idle' && !echo.busy) break;
        await sleep(100);
      }
      const events = this.eventLog.slice(run.fromEvent);
      run.runEnd = events.some((event) => event.type === 'run_end');
      const errorEvent = events.find((event) => event.type === 'error');
      const replied = this.playedLog
        .slice(run.fromPlayed)
        .some((item) => item.kind === 'reply' && (item.format === 'wav' || item.format === 'mp3'));
      run.error = errorEvent ? `the app reported ${errorEvent.type} on the Echo` : null;
      if (echo.timedOut || (!run.runEnd && !errorEvent)) {
        run.outcome = 'timeout';
        run.error ??= 'timed out waiting for RUN_END';
      } else if (errorEvent) {
        run.outcome = 'error';
      } else if (replied) {
        run.outcome = 'answered';
      } else {
        run.outcome = 'no-reply';
      }
    } catch (error) {
      run.outcome = 'error';
      run.error = String(error);
    } finally {
      run.done = true;
      run.ms = Date.now() - run.startedAtMs;
    }
  }

  private runView(run: RunRecord): Record<string, unknown> {
    return {
      id: run.id,
      done: run.done,
      outcome: run.outcome,
      runEnd: run.runEnd,
      error: run.error,
      startedAt: new Date(run.startedAtMs).toISOString(),
      ms: run.done ? run.ms : Date.now() - run.startedAtMs,
      events: this.eventLog
        .slice(run.fromEvent)
        .map((event) => ({ type: event.type, ms: event.at - run.startedAtMs })),
      played: this.playedLog
        .slice(run.fromPlayed)
        .map((item) => ({ ...item, at: new Date(item.at).toISOString() })),
    };
  }

  private mediaView(item: MediaRecord): Record<string, unknown> {
    return {
      n: item.n,
      url: item.url,
      kind: item.kind,
      format: item.format,
      sampleRate: item.sampleRate,
      bytes: item.bytes.length,
      playedBytes: item.playedBytes,
      at: item.at,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
