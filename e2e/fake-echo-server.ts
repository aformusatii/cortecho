import { createServer } from 'node:http';
import { FakeEcho } from '../apps/api/src/esphome/fake-echo.ts';
import { FAKE_ECHO_CONTROL_PORT, FAKE_ECHO_KEY, FAKE_ECHO_PORTS } from './fake-echo-config.ts';

// Four local hassmic stand-ins for the e2e run, plus a tiny control server.
// Playwright starts this process and waits on the control health endpoint; the
// app is started after the Echo ports are listening (see playwright.config.ts
// and wait-for-ports.ts), so its startup discovery scan finds them.
//
// A device's key is permanent on the real Echo, so the control server forgets
// the keys between scenarios: /reset makes every Echo unkeyed again except the
// one that must stay keyed, exactly as if its owner had removed the key.

const ECHOES = [
  { port: FAKE_ECHO_PORTS.one, index: 1 },
  { port: FAKE_ECHO_PORTS.two, index: 2 },
  { port: FAKE_ECHO_PORTS.keyed, index: 3 },
  { port: FAKE_ECHO_PORTS.hidden, index: 4 },
] as const;

const KEYED_INDEX = 3;
const keyedKey = Buffer.from(FAKE_ECHO_KEY, 'base64');

const echoes = await Promise.all(
  ECHOES.map(async ({ port, index }) => {
    const echo = new FakeEcho({
      port,
      nodeName: `e2e-fake-echo-${index}`,
      // Distinct MACs: the MAC is a device's identity, shared only by one row.
      macAddress: `02:00:00:00:00:0${index}`,
      ...(index === KEYED_INDEX ? { apiKey: Buffer.from(keyedKey) } : {}),
    });
    await echo.start();
    return echo;
  }),
);

const control = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/reset') {
    echoes.forEach((echo, position) => {
      const index = ECHOES[position]?.index;
      echo.setApiKey(index === KEYED_INDEX ? Buffer.from(keyedKey) : null);
    });
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve) => control.listen(FAKE_ECHO_CONTROL_PORT, resolve));

console.log(
  `fake Echos listening on ${echoes.map((echo) => echo.port).join(', ')}; control on ${FAKE_ECHO_CONTROL_PORT}`,
);

async function shutdown(): Promise<void> {
  control.close();
  await Promise.all(echoes.map((echo) => echo.stop()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
