import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Health } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { REPO_ROOT } from './env.ts';
import { createDevicesRepository } from './features/devices/devices.repository.ts';

/**
 * Production must start without REPLY_AUDIO_BASE_URL now (spec §8.1): the
 * refusal moved to the device problem `reply-address-missing`. This is a real
 * process because the old behaviour was a throw in server.ts.
 */
let child: ReturnType<typeof spawn> | null = null;
let tempDir: string | null = null;

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function seededDatabase(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortecho-start-'));
  tempDir = dir;
  const file = path.join(dir, 'app.db');
  const { db, sqlite } = openDatabase(file);
  runMigrations(db);
  createDevicesRepository(db).create({
    name: 'Kitchen',
    kind: 'echo',
    host: '127.0.0.1',
    // Nothing listens here: the link stays down, which is fine for /api/health.
    port: 9,
    apiKey: null,
    enabled: true,
    prompt: '',
    mac: null,
  });
  sqlite.close();
  return file;
}

function startServer(port: number, databasePath: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_PATH: databasePath,
    LOG_LEVEL: 'info',
    // No REPLY_AUDIO_BASE_URL, no OpenAI key, no ECHO_*.
  };
  child = spawn(process.execPath, ['apps/api/src/server.ts'], { cwd: REPO_ROOT, env });
  return child;
}

async function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not start in time')), 15_000);
    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('API listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code}: ${output.slice(-500)}`));
    });
  });
}

describe('production start without the reply address', () => {
  it('starts, reports reply-address-missing, and shuts down cleanly', async () => {
    const databasePath = seededDatabase();
    const port = await freePort();
    const proc = startServer(port, databasePath);
    await waitForListening(proc);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as Health;
    expect(health.devices[0]).toMatchObject({
      name: 'Kitchen',
      problem: 'reply-address-missing',
    });

    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
    proc.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 30_000);
});
