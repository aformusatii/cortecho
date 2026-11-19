import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../pipeline/audio.ts';
import { createTestRuntime, waitUntil } from '../test-support.ts';
import { FakeEcho, syntheticSpeech } from './fake-echo.ts';
import {
  type ApiMessage,
  encodeNoiseFrame,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextCodec,
} from './framing.ts';
import {
  decodeVoiceAssistantAudio,
  decodeVoiceAssistantRequest,
  encodeAnnounceRequest,
  encodeHelloRequest,
  encodeSetKeyRequest,
  encodeSubscribeVoiceAssistant,
  encodeVoiceAssistantEvent,
  MSG,
  VA_EVENT,
} from './messages.ts';
import { NoiseInitiator } from './noise.ts';

// Fidelity behaviours of the fake hassmic that are not exercised by the
// voice-pipeline tests: tested against the simulator directly, with a raw
// client in place of Home Assistant.

type RawClient = {
  socket: net.Socket;
  messages: ApiMessage[];
  send: (type: number, payload: Buffer) => void;
};

/** A plaintext client (no key): hello, then whatever the test sends. */
function rawPlaintextClient(port: number): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const codec = new PlaintextCodec();
    const messages: ApiMessage[] = [];
    socket.on('data', (chunk) => {
      for (const m of codec.push(chunk)) messages.push(m);
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest('raw')));
      resolve({ socket, messages, send: (type, payload) => socket.write(codec.encode(type, payload)) });
    });
  });
}

/** A Noise client with `key`: handshake, then hello. */
function rawNoiseClient(port: number, key: Buffer): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const initiator = new NoiseInitiator(key);
    const reader = new NoiseFrameReader();
    let frames = 0;
    const messages: ApiMessage[] = [];
    socket.on('connect', () => {
      const msg1 = initiator.writeMessage1();
      socket.write(
        Buffer.concat([
          encodeNoiseFrame(Buffer.alloc(0)),
          encodeNoiseFrame(Buffer.concat([Buffer.from([0]), msg1])),
        ]),
      );
    });
    socket.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        frames += 1;
        if (frames === 1) continue; // server hello
        if (frame[0] !== 0)
          return reject(new Error(`handshake refused: ${frame.subarray(1).toString('utf8')}`));
        const { transport } = initiator.readMessage2(frame.subarray(1));
        const codec = new NoiseTransportCodec(transport.send, transport.receive);
        const rest = reader.takeRest();
        if (rest.length > 0) for (const m of codec.push(rest)) messages.push(m);
        socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest('raw')));
        resolve({ socket, messages, send: (type, payload) => socket.write(codec.encode(type, payload)) });
      }
    });
    socket.once('error', reject);
  });
}

const WAV = () => pcmToWav(Buffer.alloc(1600, 1), 16_000);

describe('fidelity (proto_esphome.c behaviours)', () => {
  it('closes a zero-PSK connection once a key is set (F3)', async () => {
    const zero = Buffer.alloc(32);
    const key = Buffer.alloc(32, 9);
    const echo = new FakeEcho({ apiKey: null });
    const port = await echo.start();
    const a = await rawNoiseClient(port, zero);
    const b = await rawNoiseClient(port, zero);
    // A sets the device key over its zero-PSK link.
    a.send(MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST, encodeSetKeyRequest(key.toString('base64')));
    await waitUntil(() => echo.apiKey !== null);
    // B connected before the key existed: its next message closes the link.
    const closed = new Promise<void>((resolve) => b.socket.once('close', () => resolve()));
    b.send(MSG.PING_REQUEST, Buffer.alloc(0));
    await closed;
    expect(echo.echoLog).toContain('encryption: closing a connection without the key');
    await echo.stop();
  });

  it('fetches the reply early on INTENT_PROGRESS with tts_start_streaming (F13)', async () => {
    const fetched: string[] = [];
    const echo = new FakeEcho({
      fetchAudio: async (url) => {
        fetched.push(url);
        return WAV();
      },
    });
    const port = await echo.start();
    const client = await rawPlaintextClient(port);
    client.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, encodeSubscribeVoiceAssistant(true));
    await waitUntil(() => echo.isSubscribed);
    client.send(
      MSG.VOICE_ASSISTANT_EVENT_RESPONSE,
      encodeVoiceAssistantEvent(VA_EVENT.INTENT_PROGRESS, {
        tts_start_streaming: '1',
        url: 'http://x/a.wav',
      }),
    );
    const media = await echo.waitForPlayed();
    expect(media.url).toBe('http://x/a.wav');
    expect(fetched).toEqual(['http://x/a.wav']);
    await echo.stop();
  });

  it('ends the run when RUN_END arrives while still streaming (F15)', async () => {
    const echo = new FakeEcho();
    const port = await echo.start();
    const client = await rawPlaintextClient(port);
    client.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, encodeSubscribeVoiceAssistant(true));
    await waitUntil(() => echo.isSubscribed);
    const run = echo.runPipeline(Buffer.alloc(16_000 * 2 * 60)); // long enough to stay streaming
    await waitUntil(() => client.messages.some((m) => m.type === MSG.VOICE_ASSISTANT_AUDIO));
    client.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, encodeVoiceAssistantEvent(VA_EVENT.RUN_END, {}));
    await run;
    // finishPipeline ends the stream (end-of-audio) and aborts (start=false), in that order.
    await waitUntil(() =>
      client.messages.some(
        (m) => m.type === MSG.VOICE_ASSISTANT_REQUEST && !decodeVoiceAssistantRequest(m.payload).start,
      ),
    );
    const endAudio = client.messages.some(
      (m) => m.type === MSG.VOICE_ASSISTANT_AUDIO && decodeVoiceAssistantAudio(m.payload).end,
    );
    const stop = client.messages.some(
      (m) => m.type === MSG.VOICE_ASSISTANT_REQUEST && !decodeVoiceAssistantRequest(m.payload).start,
    );
    expect(endAudio).toBe(true);
    expect(stop).toBe(true);
    await echo.stop();
  });

  it('gives up after the pipeline timeout while streaming (F20)', async () => {
    const echo = new FakeEcho({ pipelineTimeoutMs: 50 });
    const port = await echo.start();
    const client = await rawPlaintextClient(port);
    client.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, encodeSubscribeVoiceAssistant(true));
    await waitUntil(() => echo.isSubscribed);
    await echo.runPipeline(Buffer.alloc(16_000 * 2 * 60));
    expect(echo.timedOut).toBe(true);
    expect(echo.echoLog).toContain('pipeline timeout');
    await echo.stop();
  });

  it('plays the preannounce then the media, and listens after start_conversation (F21)', async () => {
    const fetched: string[] = [];
    const echo = new FakeEcho({
      fetchAudio: async (url) => {
        fetched.push(url);
        return WAV();
      },
    });
    const port = await echo.start();
    const client = await rawPlaintextClient(port);
    client.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, encodeSubscribeVoiceAssistant(true));
    await waitUntil(() => echo.isSubscribed);
    client.send(
      MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST,
      encodeAnnounceRequest({
        mediaId: 'http://x/media.wav',
        text: 'Dinner is ready.',
        preannounceMediaId: 'http://x/pre.wav',
        startConversation: true,
      }),
    );
    await waitUntil(() => echo.announcements.length === 1);
    expect(fetched).toEqual(['http://x/pre.wav', 'http://x/media.wav']);
    expect(echo.announcements[0]).toMatchObject({ mediaId: 'http://x/media.wav', success: true });
    await waitUntil(() => echo.runs === 1); // start_conversation opened a follow-up run
    await echo.stop();
  });
});

describe('stop word (F11)', () => {
  it('cancels the run on a stop word, quietly, and drops what follows', async () => {
    const echo = new FakeEcho();
    const port = await echo.start();
    const ctx = createTestRuntime({ echoPort: port });
    echo.fetchAudio = ctx.fetchAudio;
    ctx.client.start();
    await waitUntil(() => echo.isSubscribed && ctx.client.isConnected);
    ctx.services.sttResult = async () => 'Computer, stop';
    await echo.runPipeline(syntheticSpeech());
    await waitUntil(() => echo.aborted);
    expect(echo.errorSounds).toBe(0);
    expect(echo.eventTypes()).toEqual(['run_start', 'stt_start', 'stt_vad_end', 'stt_end']);
    expect(echo.eventTypes()).not.toContain('intent_start');
    await waitUntil(() => ctx.pipeline.lastTurn?.outcome === 'aborted');
    await ctx.client.stop();
    await echo.stop();
    ctx.sqlite.close();
  });
});
