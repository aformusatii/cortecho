import { FakeEcho } from '../apps/api/src/esphome/fake-echo.ts';

// Two local hassmic stand-ins for the e2e run. Playwright starts this process
// (see playwright.config.ts) and waits on the first port; the tests create
// devices that point at them through the API.
const PORTS = (process.env.FAKE_ECHO_PORTS ?? '26101,26102')
  .split(',')
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isInteger(port) && port > 0);

const echoes = await Promise.all(
  PORTS.map(async (port, index) => {
    const echo = new FakeEcho({ port, nodeName: `e2e-fake-echo-${index + 1}` });
    await echo.start();
    return echo;
  }),
);

console.log(`fake Echos listening on ${echoes.map((echo) => echo.port).join(', ')}`);

async function shutdown(): Promise<void> {
  await Promise.all(echoes.map((echo) => echo.stop()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
