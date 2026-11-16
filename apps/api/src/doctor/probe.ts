import net from 'node:net';
import {
  EncryptionRequiredError,
  encodeNoiseFrame,
  NoiseFrameReader,
  NoiseTransportCodec,
  PlaintextCodec,
  PlaintextOnlyError,
} from '../esphome/framing.ts';
import { decodeHelloResponse, encodeHelloRequest, MSG } from '../esphome/messages.ts';
import { NoiseInitiator, parseApiKey } from '../esphome/noise.ts';

export type EchoProbeResult = {
  reachable: boolean;
  encryption: 'plaintext' | 'noise' | 'unknown';
  /** null when no key was tried, true when the handshake succeeded. */
  keyAccepted: boolean | null;
  nodeName?: string;
  problem?: 'unreachable' | 'timeout' | 'encryption-required' | 'invalid-key' | 'key-not-set' | 'protocol';
  message: string;
};

/**
 * Opens a short-lived ESPHome API connection and says hello. It **never**
 * subscribes to the voice assistant: hassmic gives that to the first
 * subscriber only, and the doctor must not steal it from a running instance.
 */
export function probeEcho({
  host,
  port,
  apiKey,
  timeoutMs = 4000,
  clientInfo = 'cortecho-doctor',
}: {
  host: string;
  port: number;
  /** Base64 key, or null for a plaintext probe. */
  apiKey: string | null;
  timeoutMs?: number;
  clientInfo?: string;
}): Promise<EchoProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: net.Socket;
    const finish = (result: EchoProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    let key: Buffer | null = null;
    if (apiKey) {
      try {
        key = parseApiKey(apiKey);
      } catch {
        resolve({
          reachable: false,
          encryption: 'noise',
          keyAccepted: false,
          problem: 'invalid-key',
          message: 'The stored API key is not base64 of 32 bytes.',
        });
        return;
      }
    }
    socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs, () =>
      finish({
        reachable: false,
        encryption: key ? 'noise' : 'unknown',
        keyAccepted: null,
        problem: 'timeout',
        message: `${host}:${port} did not answer within ${timeoutMs} ms.`,
      }),
    );
    socket.on('error', (error) =>
      finish({
        reachable: false,
        encryption: key ? 'noise' : 'unknown',
        keyAccepted: null,
        problem: 'unreachable',
        message: `${host}:${port} is not reachable (${error.message}).`,
      }),
    );

    if (!key) {
      const codec = new PlaintextCodec();
      socket.on('connect', () => {
        socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest(clientInfo)));
      });
      socket.on('data', (chunk) => {
        try {
          for (const { type, payload } of codec.push(chunk)) {
            if (type === MSG.HELLO_RESPONSE) {
              finish({
                reachable: true,
                encryption: 'plaintext',
                keyAccepted: null,
                nodeName: decodeHelloResponse(payload).name,
                message: `Connected in plaintext to ${decodeHelloResponse(payload).name}.`,
              });
            }
          }
        } catch (error) {
          if (error instanceof EncryptionRequiredError) {
            finish({
              reachable: true,
              encryption: 'plaintext',
              keyAccepted: null,
              problem: 'encryption-required',
              message: 'The Echo requires an API key but this device has none.',
            });
          } else {
            finish({
              reachable: true,
              encryption: 'plaintext',
              keyAccepted: null,
              problem: 'protocol',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
      return;
    }

    const initiator = new NoiseInitiator(key);
    const reader = new NoiseFrameReader();
    let transport: NoiseTransportCodec | null = null;
    // The first Noise frame is the server hello (no status byte); the second
    // one starts with the status byte and carries Noise message 2.
    let frames = 0;

    const sayHello = () => {
      const codec = transport;
      if (!codec) return;
      socket.write(codec.encode(MSG.HELLO_REQUEST, encodeHelloRequest(clientInfo)));
    };

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
        if (transport) {
          for (const { type, payload } of transport.push(chunk)) handle(type, payload);
          return;
        }
        for (const frame of reader.push(chunk)) {
          frames += 1;
          if (frames === 1) continue; // server hello
          if (frame[0] !== 0) {
            finish({
              reachable: true,
              encryption: 'noise',
              keyAccepted: false,
              problem: 'invalid-key',
              message: `The Echo refused the handshake: ${frame.subarray(1).toString('utf8') || 'no reason given'}.`,
            });
            return;
          }
          const { transport: established } = initiator.readMessage2(frame.subarray(1));
          transport = new NoiseTransportCodec(established.send, established.receive);
          sayHello();
          const rest = reader.takeRest();
          if (rest.length > 0) for (const { type, payload } of transport.push(rest)) handle(type, payload);
        }
      } catch (error) {
        if (error instanceof PlaintextOnlyError) {
          finish({
            reachable: true,
            encryption: 'noise',
            keyAccepted: false,
            problem: 'key-not-set',
            message: 'This device has a key but the Echo answered in plaintext: the Echo has no key yet.',
          });
        } else {
          finish({
            reachable: true,
            encryption: 'noise',
            keyAccepted: null,
            problem: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    function handle(type: number, payload: Buffer): void {
      if (type !== MSG.HELLO_RESPONSE) return;
      const hello = decodeHelloResponse(payload);
      finish({
        reachable: true,
        encryption: 'noise',
        keyAccepted: true,
        nodeName: hello.name,
        message: `Encrypted link accepted by ${hello.name}.`,
      });
    }
  });
}
