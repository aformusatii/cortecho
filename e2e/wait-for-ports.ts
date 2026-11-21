import { connect } from 'node:net';

// e2e harness only: block until the FakeEcho ports accept a connection, so the
// app's startup discovery scan sees them. Otherwise the scan runs first and the
// server's one-scan-per-minute limit hides the Echos for a whole minute. This
// changes nothing in the app; production never runs this file.

const ports = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((port) => Number.isInteger(port) && port > 0);
const TIMEOUT_MS = 30_000;
const startedAt = Date.now();

async function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function waitFor(port: number): Promise<void> {
  for (;;) {
    if (await reachable(port)) return;
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.error(`wait-for-ports: ${port} did not open within ${TIMEOUT_MS} ms`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

await Promise.all(ports.map(waitFor));
