import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each run writes `smoke/.runs/<run id>/` (spec §8): `report.md` plus one file
 * per step (`in.wav`, `reply.wav`, `wire.json`, `turn.json`, `server.log`,
 * `echo.log`). The agent reads `report.md` first and opens the WAVs or logs
 * only for failures; the owner can listen to any step.
 */

const SMOKE_DIR = fileURLToPath(new URL('..', import.meta.url));
const RUNS_DIR = path.join(SMOKE_DIR, '.runs');

/** smoke-<yyyymmdd-hhmmss>, one per run. */
export function newRunId(now = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `smoke-${stamp}`;
}

export class Report {
  readonly runDir: string;
  readonly runId: string;
  private readonly lines: string[] = [];

  constructor(runId: string) {
    this.runId = runId;
    this.runDir = path.join(RUNS_DIR, runId);
    mkdirSync(this.runDir, { recursive: true });
  }
  heading(text: string): void {
    this.lines.push(`## ${text}`);
  }

  line(text: string): void {
    this.lines.push(text);
  }

  /** Records a scenario result. */
  scenario(name: string, passed: boolean, detail = ''): void {
    this.lines.push(`- ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  /** Writes one step's artifact (relative to the run dir). */
  step(name: string, content: string | Buffer): void {
    const file = path.join(this.runDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** Writes report.md. */
  finish(): void {
    writeFileSync(path.join(this.runDir, 'report.md'), `${this.lines.join('\n')}\n`);
  }
}
