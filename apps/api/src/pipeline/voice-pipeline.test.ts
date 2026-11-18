import { afterEach, describe, expect, it } from 'vitest';
import { FakeEcho, syntheticSpeech } from '../esphome/fake-echo.ts';
import { MSG } from '../esphome/messages.ts';
import { createTestRuntime, waitUntil } from '../test-support.ts';
import { expectsAnswer, followUpVad } from './voice-pipeline.ts';

// End-to-end against a fake hassmic (ESPHome mode) on localhost: real TCP,
// real framing (plaintext and Noise), real EsphomeClient, VAD guard and HTTP
// reply endpoint; only the OpenAI services are fakes.

const ANSWER_EVENTS = [
  'run_start',
  'stt_start',
  'stt_vad_end',
  'stt_end',
  'intent_start',
  'intent_end',
  'tts_start',
  'tts_end',
  'run_end',
];
const QUIET_END = ['run_start', 'stt_start', 'stt_vad_end', 'error', 'run_end'];

let echo: FakeEcho;
let ctx: ReturnType<typeof createTestRuntime>;

type SetupOptions = { apiKey?: Buffer | null; echoKey?: Buffer | null; env?: Record<string, string> };

async function setup({ apiKey = null, echoKey = apiKey, env = {} }: SetupOptions = {}) {
  echo = new FakeEcho({ apiKey: echoKey });
  const port = await echo.start();
  ctx = createTestRuntime({ echoPort: port, apiKey, env });
  echo.fetchAudio = ctx.fetchAudio;
  ctx.client.start();
}

async function connected() {
  await waitUntil(() => echo.isSubscribed && ctx.client.isConnected);
}

afterEach(async () => {
  await ctx?.client.stop();
  await echo?.stop();
  ctx?.sqlite.close();
});

describe('connecting', () => {
  it('says hello, reads the device info, subscribes and answers the time request', async () => {
    await setup({ env: { TZ: 'Europe/Berlin' } });
    await connected();
    await waitUntil(() => ctx.client.info !== null && echo.timeAnswers.length > 0);
    expect(ctx.client.echoInfo).toMatchObject({
      name: 'fake-echo',
      supportsAnnounce: true,
      supportsFollowUp: true,
    });
    const types = echo.received.map((m) => m.type);
    expect(types.slice(0, 4)).toEqual([
      MSG.HELLO_REQUEST,
      MSG.CONNECT_REQUEST,
      MSG.DEVICE_INFO_REQUEST,
      MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST,
    ]);
    const [time] = echo.timeAnswers;
    expect(Math.abs((time?.epochSeconds ?? 0) - Date.now() / 1000)).toBeLessThan(5);
    expect(time).toMatchObject({ timezone: 'CET-1CEST,M3.5.0,M10.5.0/3', keyed: false });
    expect(ctx.client.lastTimeSyncAt).not.toBeNull();
  });

  it('connects encrypted with the key, and the time answer then counts for the clock', async () => {
    const key = Buffer.alloc(32, 5);
    await setup({ apiKey: key });
    await connected();
    await waitUntil(() => echo.timeAnswers.length > 0);
    expect(echo.timeAnswers[0]?.keyed).toBe(true);
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn?.outcome === 'answered');
  });

  it('reports a plaintext refusal (the Echo got a key) and a wrong key', async () => {
    await setup({ apiKey: null, echoKey: Buffer.alloc(32, 1) });
    await waitUntil(() => ctx.client.problem === 'encryption-required');
    expect(ctx.client.isConnected).toBe(false);
    await ctx.client.stop();
    await echo.stop();
    ctx.sqlite.close();

    await setup({ apiKey: Buffer.alloc(32, 2), echoKey: Buffer.alloc(32, 1) });
    await waitUntil(() => ctx.client.problem === 'invalid-key');
  });

  it('reconnects after the Echo drops the link and subscribes again', async () => {
    await setup();
    await connected();
    echo.dropConnection();
    await waitUntil(() => !echo.isSubscribed);
    await connected();
    expect(ctx.client.reconnects).toBeGreaterThanOrEqual(1);
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn?.outcome === 'answered');
  });

  it('gets ping answers', async () => {
    await setup();
    await waitUntil(() => ctx.client.lastPongAt !== null);
  });
});

describe('voice turns', () => {
  it('answers a request: events in Home Assistant order, the reply fetched as WAV, then played', async () => {
    await setup();
    await connected();
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);

    expect(echo.eventTypes()).toEqual(ANSWER_EVENTS);
    expect(echo.received.some((m) => m.type === MSG.VOICE_ASSISTANT_RESPONSE)).toBe(true);
    const data = Object.fromEntries(echo.events.map((e) => [e.type, e.data]));
    expect(data.stt_end).toEqual({ text: 'what time is it' });
    expect(data.intent_end).toEqual({ continue_conversation: '0' });
    expect(data.tts_start).toEqual({ text: 'It is noon.' });
    expect(data.tts_end?.url).toMatch(/^http:\/\/voice-agent\.test\/api\/reply-audio\/[\w-]{22}\.wav$/);
    expect(echo.played[0]).toMatchObject({ kind: 'reply', format: 'wav', sampleRate: 24000, bytes: 24000 });

    expect(ctx.pipeline.lastTurn).toMatchObject({
      source: 'voice',
      outcome: 'answered',
      transcript: 'what time is it',
      reply: 'It is noon.',
    });
    expect(ctx.pipeline.lastTurn?.timings.playedMs).toBeGreaterThan(0);
    expect(ctx.pipeline.state).toBe('idle');
    expect(echo.state).toBe('idle');
    expect(echo.errorSounds).toBe(0);

    // The reply URL stops working once the turn is over.
    const stale = await ctx.app.request(new URL(data.tts_end?.url ?? '').pathname);
    expect(stale.status).toBe(404);
  });

  it('transcribes during the closing pause and uses that result', async () => {
    await setup();
    await connected();
    let sttStartedWhile = '';
    ctx.services.sttResult = async () => {
      sttStartedWhile ||= ctx.pipeline.state;
      return 'what time is it';
    };
    await echo.runPipeline(syntheticSpeech({ trailSilenceMs: 0 }));
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'answered', transcript: 'what time is it' });
    expect(sttStartedWhile).toBe('listening');
    expect(ctx.services.calls.stt).toBe(1);
  });

  it('transcribes again when the user goes on after a pause', async () => {
    await setup();
    await connected();
    let call = 0;
    ctx.services.sttResult = async () => {
      call += 1;
      return call === 1 ? 'turn on' : 'turn on the kitchen light';
    };
    // 450 ms pause: longer than STT_EAGER_SILENCE_MS (300), shorter than VAD_END_SILENCE_MS (800).
    const utterance = Buffer.concat([
      syntheticSpeech({ speechMs: 600, trailSilenceMs: 450 }),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 600, trailSilenceMs: 0 }),
    ]);
    await echo.runPipeline(utterance);
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.services.calls.stt).toBe(2);
    expect(ctx.services.calls.agent).toEqual(['turn on the kitchen light']);
  });

  it('waits for the end of the utterance when STT_EAGER_SILENCE_MS is 0', async () => {
    await setup({ env: { STT_EAGER_SILENCE_MS: '0' } });
    await connected();
    let sttStartedWhile = '';
    ctx.services.sttResult = async () => {
      sttStartedWhile ||= ctx.pipeline.state;
      return 'hello';
    };
    await echo.runPipeline(syntheticSpeech({ trailSilenceMs: 0 }));
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(sttStartedWhile).toBe('thinking');
    expect(ctx.services.calls.stt).toBe(1);
  });

  it('starts speaking the first sentence while the agent writes the rest: one reply, two TTS requests', async () => {
    await setup();
    await connected();
    let ttsWhenAgentDone: string[] = [];
    ctx.services.agentResult = async (_text, onText) => {
      onText?.('The living room is at 21 degrees.');
      onText?.('The living room is at 21 degrees. The bed');
      await new Promise((resolve) => setTimeout(resolve, 30));
      ttsWhenAgentDone = [...ctx.services.calls.tts];
      return { text: 'The living room is at 21 degrees. The bedroom is at 19.', toolCalls: [] };
    };
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ttsWhenAgentDone).toEqual(['The living room is at 21 degrees.']);
    expect(ctx.services.calls.tts).toEqual(['The living room is at 21 degrees.', 'The bedroom is at 19.']);
    expect(echo.eventTypes()).toEqual(ANSWER_EVENTS);
    const data = Object.fromEntries(echo.events.map((e) => [e.type, e.data]));
    expect(data.tts_start).toEqual({ text: 'The living room is at 21 degrees. The bedroom is at 19.' });
    // Both parts in the one WAV the Echo downloaded.
    expect(echo.played).toHaveLength(1);
    expect(echo.played[0]).toMatchObject({ kind: 'reply', bytes: 48000 });
    expect(ctx.pipeline.lastTurn?.outcome).toBe('answered');
  });

  it('drops audio started for text that was not the answer (written before a tool call)', async () => {
    await setup();
    await connected();
    ctx.services.agentResult = async (_text, onText) => {
      onText?.('Let me look that up for you. One');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: 'It is 21 degrees.', toolCalls: [] };
    };
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.services.calls.tts).toEqual(['Let me look that up for you.', 'It is 21 degrees.']);
    expect(echo.played).toHaveLength(1);
    expect(echo.played[0]).toMatchObject({ kind: 'reply', bytes: 24000 });
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'answered', reply: 'It is 21 degrees.' });
  });

  it('apologises when the agent fails after its first sentence was already being spoken', async () => {
    await setup();
    await connected();
    ctx.services.agentResult = async (_text, onText) => {
      onText?.('The living room is at 21 degrees. The');
      throw new Error('model down');
    };
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'error', error: 'model down' });
    expect(ctx.services.calls.tts.at(-1)).toBe('Sorry, something went wrong. Please try again.');
    expect(echo.played).toHaveLength(1);
  });

  it('asks a question back: continue_conversation, then a follow-up without the wake word', async () => {
    await setup();
    await connected();
    let call = 0;
    ctx.services.agentResult = async (text) => {
      call += 1;
      return call === 1
        ? { text: 'Which room?', toolCalls: [], listen: { waitMs: 6000 } }
        : { text: `Turning on the ${text}.`, toolCalls: [] };
    };
    ctx.services.sttResult = async () => (call === 0 ? 'turn on the light' : 'kitchen');
    // The follow-up run carries an answer this time.
    echo.followUpAudio = syntheticSpeech();

    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2, 8000);
    const [second, first] = ctx.turns.latest(5);
    expect(first).toMatchObject({ outcome: 'answered', reply: 'Which room?' });
    expect(second).toMatchObject({
      outcome: 'answered',
      transcript: 'kitchen',
      reply: 'Turning on the kitchen.',
    });
    expect(echo.runs).toBe(2);
    expect(
      echo.events.filter((e) => e.type === 'intent_end').map((e) => e.data.continue_conversation),
    ).toEqual(['1', '0']);
  });

  it('ends quietly when nobody answers the follow-up, after the wait the model chose', async () => {
    // The usual no-speech timeout (8 s) would outlast the waits below: the model's 1 s is what ends it.
    await setup();
    await connected();
    ctx.services.agentResult = async () => ({ text: 'Shall I?', toolCalls: [], listen: { waitMs: 1000 } });
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2, 8000);
    // Our side records the turn before the fake Echo has read the last events.
    await waitUntil(() => echo.eventTypes().filter((t) => t === 'run_end').length === 2);
    // The silent follow-up can be recorded before the first turn has finished.
    expect(
      ctx.turns
        .latest(5)
        .map((t) => t.outcome)
        .sort(),
    ).toEqual(['answered', 'no-speech']);
    expect(echo.events.slice(-2)).toEqual([
      { type: 'error', data: { code: 'stt-no-text-recognized', message: 'No speech recognised' } },
      { type: 'run_end', data: {} },
    ]);
    expect(echo.errorSounds).toBe(0);
    expect(echo.runs).toBe(2); // no third run
    await echo.waitForIdle();
  });

  it("does not take the Echo's wake sound at a follow-up start for the answer", async () => {
    await setup();
    await connected();
    ctx.services.agentResult = async () => ({ text: 'Say yes.', toolCalls: [], listen: { waitMs: 4000 } });
    // hassmic: 800 ms of digital silence (lead_in), then the mic opens with the
    // 650 ms wake sound playing (core_pipeline_finish: "wake sound, then it
    // listens"). Counting that as speech ended the follow-up after 800 ms of
    // silence, ~1.3 s in, before the user could answer (2026-11-18).
    echo.followUpAudio = Buffer.concat([
      Buffer.alloc(16_000 * 2 * 0.8),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 760, trailSilenceMs: 0, amplitude: 0.3 }),
    ]);
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2, 8000);
    await waitUntil(() => echo.eventTypes().filter((t) => t === 'run_end').length === 2);
    expect(
      ctx.turns
        .latest(5)
        .map((t) => t.outcome)
        .sort(),
    ).toEqual(['answered', 'no-speech']);
    // Only the first turn was transcribed: the follow-up waited its 4 s
    // instead of deciding on the wake sound and sending it to STT.
    expect(ctx.services.calls.stt).toBe(1);
    await echo.waitForIdle();
  });

  it("hears an answer given inside a follow-up's 2 s guard (the VAD is deaf, STT is not)", async () => {
    await setup();
    await connected();
    let agentCalls = 0;
    ctx.services.agentResult = async (text) => {
      agentCalls += 1;
      if (agentCalls === 1) return { text: 'Do you want it?', toolCalls: [], listen: { waitMs: 4000 } };
      return { text: `Okay: ${text}`, toolCalls: [] };
    };
    let sttCalls = 0;
    ctx.services.sttResult = async () => (++sttCalls === 1 ? 'send an email' : 'yes');
    // hassmic's lead-in, the wake sound, a pause, then "yes" at ~1 s of live
    // audio — inside the 2 s VAD guard. The audio is kept, so the opening check
    // transcribes it and the answer is not lost.
    echo.followUpAudio = Buffer.concat([
      Buffer.alloc(16_000 * 2 * 0.8),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 760, trailSilenceMs: 0, amplitude: 0.3 }),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 0, trailSilenceMs: 200 }),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 400, trailSilenceMs: 0, amplitude: 0.3 }),
      syntheticSpeech({ leadSilenceMs: 0, speechMs: 0, trailSilenceMs: 3000 }),
    ]);
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2, 8000);
    await waitUntil(() => echo.eventTypes().filter((t) => t === 'run_end').length === 2);
    const [second, first] = ctx.turns.latest(5);
    expect(first).toMatchObject({ outcome: 'answered', reply: 'Do you want it?' });
    expect(second).toMatchObject({ outcome: 'answered', transcript: 'yes', reply: 'Okay: yes' });
    expect(ctx.services.calls.stt).toBeGreaterThanOrEqual(2);
    await echo.waitForIdle();
  });

  it('does not listen after a question mark alone (the fallback is off by default)', async () => {
    await setup();
    await connected();
    ctx.services.agentResult = async () => ({ text: 'Anything else?', toolCalls: [] });
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn?.outcome === 'answered');
    await echo.waitForIdle();
    expect(echo.events.find((e) => e.type === 'intent_end')?.data.continue_conversation).toBe('0');
    expect(echo.runs).toBe(1);
  });

  it('listens after a question mark when FOLLOW_UP_QUESTION_MARK_FALLBACK is on', async () => {
    await setup({ env: { FOLLOW_UP_QUESTION_MARK_FALLBACK: 'true', VAD_NO_SPEECH_TIMEOUT_MS: '1000' } });
    await connected();
    ctx.services.agentResult = async () => ({ text: 'Anything else?', toolCalls: [] });
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.turns.latest(5).length === 2, 8000);
    expect(echo.events.find((e) => e.type === 'intent_end')?.data.continue_conversation).toBe('1');
    expect(echo.runs).toBe(2);
    await echo.waitForIdle();
  });

  it('ends listening on our VAD while the Echo keeps streaming (end_of_request off, its default)', async () => {
    await setup();
    await connected();
    // 1.2 s of speech, then the Echo just keeps sending the quiet room.
    await echo.runPipeline(syntheticSpeech({ trailSilenceMs: 0 }));
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(echo.eventTypes()).toEqual(ANSWER_EVENTS);
    const speechEndMs = ctx.pipeline.lastTurn?.timings.speechEndMs ?? 0;
    expect(echo.received.filter((m) => m.type === MSG.VOICE_ASSISTANT_AUDIO)).toHaveLength(0); // we send no audio
    expect(speechEndMs).toBeGreaterThan(0);
  });

  it('ends listening when the Echo sends end-of-audio itself (end_of_request on)', async () => {
    await setup();
    await connected();
    echo.endOfRequest = true;
    // Only 300 ms of silence after the speech: too short for our VAD, so the Echo's end decides.
    await echo.runPipeline(syntheticSpeech({ trailSilenceMs: 300 }));
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.pipeline.lastTurn?.outcome).toBe('answered');
  });

  it('ends quietly when the Echo ends a request with only silence in it', async () => {
    await setup();
    await connected();
    echo.endOfRequest = true;
    await echo.runPipeline(Buffer.alloc(16000 * 2 * 2));
    await echo.waitForEvent('run_end');
    expect(echo.eventTypes()).toEqual(QUIET_END);
    expect(echo.events[3]?.data.code).toBe('stt-no-text-recognized');
    expect(ctx.pipeline.lastTurn?.outcome).toBe('no-speech');
    expect(ctx.services.calls.stt).toBe(0);
  });

  it('stops listening by itself when nobody speaks and the Echo keeps streaming', async () => {
    await setup({ env: { VAD_NO_SPEECH_TIMEOUT_MS: '1000' } });
    await connected();
    await echo.runPipeline(Buffer.alloc(16000 * 2 * 9));
    await echo.waitForEvent('run_end');
    expect(echo.eventTypes()).toEqual(QUIET_END);
    expect(ctx.pipeline.lastTurn?.timings.speechEndMs).toBeLessThan(5000);
  }, 10_000);

  it('treats a punctuation-only transcript as no speech', async () => {
    await setup();
    await connected();
    ctx.services.sttResult = async () => ' . ';
    await echo.runPipeline(syntheticSpeech());
    await echo.waitForEvent('run_end');
    expect(echo.eventTypes()).toEqual(QUIET_END);
  });

  it('drops the run when the Echo aborts it, and sends nothing more for it', async () => {
    await setup();
    await connected();
    ctx.services.sttResult = () => new Promise((resolve) => setTimeout(() => resolve('hello'), 300));
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => echo.eventTypes().includes('stt_vad_end'));
    echo.abort();
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'aborted', error: 'aborted on the Echo' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(echo.eventsAfterAbort).toBe(0);
    expect(ctx.services.calls.agent).toEqual([]);
    expect(ctx.pipeline.state).toBe('idle');
  });

  it('drops the run when the Echo aborts while listening', async () => {
    await setup();
    await connected();
    const run = echo.runPipeline(Buffer.alloc(16000 * 2 * 3));
    await waitUntil(() => echo.eventTypes().includes('stt_start'));
    echo.abort();
    await run;
    await waitUntil(() => ctx.pipeline.lastTurn?.outcome === 'aborted');
    expect(echo.eventsAfterAbort).toBe(0);
  });

  it('speaks an apology when the agent fails', async () => {
    await setup();
    await connected();
    ctx.services.agentResult = async () => {
      throw new Error('OpenAI is down');
    };
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.services.calls.tts).toEqual([ctx.runtime.settings.current().settings.assistant.apologyText]);
    expect(echo.eventTypes()).toEqual(ANSWER_EVENTS);
    expect(echo.events.find((e) => e.type === 'intent_end')?.data).toEqual({ continue_conversation: '0' });
    expect(echo.played).toHaveLength(1);
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'error', error: 'OpenAI is down' });
    expect(echo.errorSounds).toBe(0);
  });

  it('sends ERROR + RUN_END when even the apology cannot be spoken', async () => {
    await setup();
    await connected();
    ctx.services.sttResult = async () => {
      throw new Error('network down');
    };
    ctx.services.ttsChunks = () => {
      throw new Error('network down');
    };
    await echo.runPipeline(syntheticSpeech());
    await echo.waitForEvent('run_end');
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(echo.eventTypes()).toEqual(['run_start', 'stt_start', 'stt_vad_end', 'error', 'run_end']);
    expect(echo.events[3]?.data.code).toBe('pipeline-error');
    expect(echo.errorSounds).toBe(1);
    expect(ctx.pipeline.lastTurn?.outcome).toBe('error');
    await echo.waitForIdle();
  });

  it('aborts the turn when the Echo disconnects mid-turn', async () => {
    await setup();
    await connected();
    ctx.services.agentResult = () =>
      new Promise((resolve) => setTimeout(() => resolve({ text: 'x', toolCalls: [] }), 300));
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => echo.eventTypes().includes('intent_start'));
    echo.dropConnection();
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(ctx.pipeline.lastTurn).toMatchObject({ outcome: 'aborted', error: 'echo disconnected' });
    expect(ctx.pipeline.state).toBe('idle');
  });

  it('resamples the reply when TTS_OUTPUT_RATE is set', async () => {
    await setup({ env: { TTS_OUTPUT_RATE: '16000' } });
    await connected();
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => ctx.pipeline.lastTurn !== null);
    expect(echo.played[0]?.sampleRate).toBe(16000);
    expect(Math.abs((echo.played[0]?.bytes ?? 0) - 16000)).toBeLessThanOrEqual(8); // 0.5 s at 16 kHz
  });
});

describe('announcements (/say)', () => {
  it('announces with the reply URL and waits until the Echo played it; refuses while busy', async () => {
    await setup();
    await connected();
    const said = ctx.pipeline.say('Dinner is ready.');
    await expect(ctx.pipeline.say('again')).rejects.toMatchObject({ code: 'ECHO_BUSY' });
    const turn = await said;
    expect(turn).toMatchObject({ source: 'say', outcome: 'answered', reply: 'Dinner is ready.' });
    expect(turn.timings.playedMs).toBeGreaterThan(0);
    expect(echo.announcements).toEqual([
      {
        mediaId: expect.stringMatching(/\/api\/reply-audio\/[\w-]{22}\.wav$/),
        text: 'Dinner is ready.',
        success: true,
      },
    ]);
    expect(echo.played[0]).toMatchObject({ kind: 'announcement', format: 'wav' });
    expect(echo.events).toEqual([]); // no pipeline events for an announcement
  });

  it('reports an announcement the Echo did not play', async () => {
    await setup();
    await connected();
    echo.fetchAudio = async () => {
      throw new Error('unreachable');
    };
    await expect(ctx.pipeline.say('Hello')).rejects.toMatchObject({ code: 'ECHO_BUSY' });
    expect(ctx.pipeline.lastTurn?.outcome).toBe('error');
    expect(ctx.pipeline.state).toBe('idle');
  });
});

describe('expectsAnswer (FOLLOW_UP_MODE)', () => {
  it('tool mode follows the model, with the question mark only as an opt-in fallback', () => {
    expect(expectsAnswer('Which room?', 'tool')).toBe(false);
    expect(expectsAnswer('Tell me which room.', 'tool', { listen: true })).toBe(true);
    expect(expectsAnswer('Which room?', 'tool', { questionMarkFallback: true })).toBe(true);
    expect(expectsAnswer('It is noon.', 'tool', { questionMarkFallback: true })).toBe(false);
    expect(expectsAnswer('Which room?', 'never', { listen: true })).toBe(false);
  });

  it('question mode listens again after a question only', () => {
    expect(expectsAnswer('Which room?', 'question')).toBe(true);
    expect(expectsAnswer('Do you mean "the kitchen?"', 'question')).toBe(true);
    expect(expectsAnswer('It is noon.', 'question')).toBe(false);
    expect(expectsAnswer('It is noon.', 'always')).toBe(true);
    expect(expectsAnswer('Which room?', 'never')).toBe(false);
  });
});

describe('followUpVad', () => {
  const vad = { noSpeechTimeoutMs: 8000, maxUtteranceMs: 15000, endSilenceMs: 800 };
  it('waits as asked and leaves the answer its length, within the 30 s hassmic allows', () => {
    expect(followUpVad(vad, null)).toEqual({ ...vad, startGuardMs: 2000 });
    expect(followUpVad(vad, 5000)).toEqual({
      ...vad,
      startGuardMs: 2000,
      noSpeechTimeoutMs: 5000,
      maxUtteranceMs: 20000,
    });
    expect(followUpVad(vad, 20000)).toEqual({
      ...vad,
      startGuardMs: 2000,
      noSpeechTimeoutMs: 20000,
      maxUtteranceMs: 27000,
    });
  });
});
