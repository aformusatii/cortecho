import { createControlServer } from './control.ts';
import { EchoHost } from './echo-host.ts';
import { loadFixture } from './fixture.ts';

const HASSMIC_VERSION = '2026.11.08.115848';
const FIXTURE = process.env.ECHO_FIXTURE ?? '/app/onboarding/fixtures/what-time-is-it.wav';

function int(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const host = new EchoHost({
  bind: process.env.ECHO_BIND ?? '0.0.0.0',
  port: int('ECHO_PORT', 26053),
  wakeDb: number('ECHO_WAKE_DBFS', -38),
  roomDb: number('ECHO_ROOM_DBFS', -60),
  nodeName: process.env.ECHO_NODE_NAME ?? 'echo-dot-2-5c0e11',
  friendlyName: process.env.ECHO_FRIENDLY_NAME ?? 'Echo Dot 2 5c0e11',
  macAddress: process.env.ECHO_MAC ?? '02:42:0a:e7:2f:15',
  hassmicVersion: HASSMIC_VERSION,
});

const fixturePcm = loadFixture(FIXTURE, {
  speechDb: number('ECHO_SPEECH_DBFS', -26),
  roomDb: number('ECHO_ROOM_DBFS', -60),
});

await host.start();
createControlServer(host, fixturePcm, int('ECHO_CONTROL_PORT', 8080));

console.log(
  `echo-sim: ${process.env.ECHO_FRIENDLY_NAME ?? 'Echo Dot 2 5c0e11'} on :${int('ECHO_PORT', 26053)} (control :${int('ECHO_CONTROL_PORT', 8080)})`,
);

async function shutdown(): Promise<void> {
  await host.stop();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
