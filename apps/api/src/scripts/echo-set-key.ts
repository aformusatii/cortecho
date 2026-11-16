/**
 * One-time setup, run by the owner (never by the app): gives the Echo its
 * ESPHome API key, the way Home Assistant does when it adopts a device.
 *
 *   npm run echo-set-key -- --host 192.168.1.50 [--env-file cortecho.env]
 *
 * With no ECHO_API_KEY in the environment or --key, it generates a 32-byte key,
 * sends it to the Echo, writes ECHO_API_KEY into the env file (mode 0600) and
 * never prints it. Then add the same key on the Echo's Connection tab.
 *
 * It connects with Noise and the all-zero PSK (what hassmic accepts while it
 * has no key), sends NoiseEncryptionSetKeyRequest and prints the answer.
 * hassmic stores the key in state/api_key; from then on only clients with
 * that key get in, and it takes their time for its clock.
 *
 * This CHANGES THE ECHO. Undo: delete /data/local/hassmic/state/api_key on the
 * Echo and restart hassmic (`stop hassmic; start hassmic`).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { REPO_ROOT } from '../env.ts';
import { encodeNoiseFrame, NoiseFrameReader, NoiseTransportCodec } from '../esphome/framing.ts';
import {
  decodeHelloResponse,
  decodeSetKeyResponse,
  encodeHelloRequest,
  encodeSetKeyRequest,
  MSG,
} from '../esphome/messages.ts';
import { NoiseInitiator, parseApiKey } from '../esphome/noise.ts';
import { writeEnvFile } from './env-file.ts';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const host = option('host') ?? process.env.ECHO_HOST?.trim();
const port = Number(option('port') ?? process.env.ECHO_PORT?.trim() ?? 26053);
// npm runs workspace scripts from apps/api, so the default file must be
// resolved from the repository root, not the current directory.
const envFile = path.resolve(REPO_ROOT, option('env-file') ?? 'cortecho.env');
const providedKey = option('key') ?? process.env.ECHO_API_KEY?.trim();

if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`usage: npm run echo-set-key -- --host <echo-ip> [--port 26053] [--env-file cortecho.env]

Add --key <base64> to use an existing key; otherwise one is generated and
written to the env file. This changes the Echo.`);
  process.exit(2);
}

const keyText = providedKey || randomBytes(32).toString('base64');
parseApiKey(keyText); // validates; throws on a bad key

const socket = net.createConnection({ host, port });
socket.setTimeout(10_000, () => fail('timed out'));

function fail(message: string): never {
  console.error(`echo-set-key: ${message}`);
  socket.destroy();
  process.exit(1);
}

const initiator = new NoiseInitiator(Buffer.alloc(32));
const reader = new NoiseFrameReader();
let frames = 0;
let codec: NoiseTransportCodec | null = null;

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
  try {
    const messages = codec ? codec.push(chunk) : [];
    if (!codec) {
      for (const frame of reader.push(chunk)) {
        frames += 1;
        if (frames === 1) continue; // server hello
        if (codec) {
          messages.push((codec as NoiseTransportCodec).decodeFrame(frame));
          continue;
        }
        if (frame[0] !== 0) {
          fail(
            `the Echo refused the zero key (${frame.subarray(1).toString('utf8')}): it already has a key. ` +
              'Delete state/api_key on the Echo first if you want to replace it.',
          );
        }
        const { transport } = initiator.readMessage2(frame.subarray(1));
        codec = new NoiseTransportCodec(transport.send, transport.receive);
        socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest('echo-set-key')));
      }
    }
    for (const { type, payload } of messages) {
      if (type === MSG.HELLO_RESPONSE && codec) {
        console.log(`connected to ${decodeHelloResponse(payload).name}; sending the key`);
        socket.write(codec.encode(MSG.NOISE_ENCRYPTION_SET_KEY_REQUEST, encodeSetKeyRequest(keyText)));
      } else if (type === MSG.NOISE_ENCRYPTION_SET_KEY_RESPONSE) {
        const { success } = decodeSetKeyResponse(payload);
        if (!success) fail('the Echo refused the key (see its boot.log: "encryption: ...")');
        if (!providedKey) writeEnvFile(envFile, 'ECHO_API_KEY', keyText);
        console.log(
          `the Echo stored the key: only encrypted connections with it from now on. ` +
            (providedKey
              ? 'The key was provided, so no file was written.'
              : `It was written to ${envFile} (mode 0600) and is never printed here.`),
        );
        socket.end();
        process.exit(0);
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

socket.on('error', (error) => fail(error.message));
socket.on('close', () => fail('the Echo closed the connection'));
