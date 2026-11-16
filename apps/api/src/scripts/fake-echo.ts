/**
 * Manual end-to-end test without the real Echo:
 *
 *   npm run fake-echo -- question.wav [--port 26099] [--out answer.wav] [--turns 1] [--key <base64>]
 *
 * Starts a fake hassmic (ESPHome mode) on 127.0.0.1:<port> and waits for the
 * app to connect. Start the app with
 *   ECHO_HOST=127.0.0.1 ECHO_PORT=<port> REPLY_AUDIO_BASE_URL=http://127.0.0.1:3000
 * (plus ECHO_API_KEY=<the same key> when --key is given). Then it plays the
 * WAV as a wake-word run, logs every pipeline event the app sends, downloads
 * the reply from the URL in TTS_END like the Echo, and writes it to --out.
 * Any PCM WAV works; it is converted to 16 kHz mono 16-bit first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FakeEcho } from '../esphome/fake-echo.ts';
import { parseApiKey } from '../esphome/noise.ts';
import { LinearResampler, parseWav } from '../pipeline/audio.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '26099' },
    out: { type: 'string', default: 'answer.wav' },
    turns: { type: 'string', default: '1' },
    key: { type: 'string' },
  },
});

const file = positionals[0];
if (!file) {
  console.error(
    'usage: npm run fake-echo -- <question.wav> [--port 26099] [--out answer.wav] [--turns 1] [--key <base64>]',
  );
  process.exit(2);
}

const wav = parseWav(readFileSync(file));
if (wav.bitsPerSample !== 16) throw new Error('WAV must be 16-bit PCM');
let pcm = wav.pcm;
if (wav.channels !== 1) {
  // Keep the first channel.
  const mono = Buffer.alloc((pcm.length / wav.channels) | 0);
  for (let i = 0; i < mono.length / 2; i++) mono.writeInt16LE(pcm.readInt16LE(i * 2 * wav.channels), i * 2);
  pcm = mono;
}
if (wav.sampleRate !== 16000) pcm = new LinearResampler(wav.sampleRate, 16000).push(pcm);
// The real Echo ends the request itself; here the end comes after 0.8 s of trailing silence.
const input = Buffer.concat([Buffer.alloc(16000 * 2 * 0.3), pcm, Buffer.alloc(16000 * 2 * 0.8)]);

let answer: Buffer | null = null;
const echo = new FakeEcho({
  port: Number(values.port),
  apiKey: values.key ? parseApiKey(values.key) : null,
  realtime: true,
  playedDelayMs: 50,
  fetchAudio: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    answer = Buffer.from(await response.arrayBuffer());
    return answer;
  },
});
await echo.start();
console.log(
  `fake echo listening on 127.0.0.1:${echo.port}${values.key ? ' (encrypted)' : ''}; start the app with ` +
    `ECHO_HOST=127.0.0.1 ECHO_PORT=${echo.port} REPLY_AUDIO_BASE_URL=http://127.0.0.1:3000`,
);

const started = { at: Date.now() };
echo.on('event', (event) => {
  console.log(`+${Date.now() - started.at} ms  ← ${event.type} ${JSON.stringify(event.data)}`);
});
await new Promise<void>((resolve) => {
  const check = () => (echo.isSubscribed ? resolve() : setTimeout(check, 100));
  check();
});
console.log('app connected and subscribed');

for (let turn = 1; turn <= Number(values.turns); turn++) {
  echo.clear();
  answer = null;
  started.at = Date.now();
  console.log(`--- turn ${turn}: sending ${(input.length / 32000).toFixed(1)} s of audio`);
  await echo.runPipeline(input);
  const end = await Promise.race([
    echo.waitForPlayed(60_000),
    echo.waitForEvent('error', { timeoutMs: 60_000 }),
  ]);
  if ('url' in end && answer) {
    writeFileSync(values.out, answer);
    console.log(`answer: ${end.format}, ${end.sampleRate} Hz, ${end.bytes} bytes → ${values.out}`);
  }
  await echo.waitForIdle(30_000).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log(`time answers: ${JSON.stringify(echo.timeAnswers)}`);
await echo.stop();
process.exit(0);
