import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The production container's stdout log (spec §3): `docker logs <container>
 * --since <iso>`. The code-server container can reach the Docker socket, so
 * this is a plain exec. Failures return `[]` — the log is one of four
 * assertion sources, never a hard dependency.
 */
export class ServerLog {
  readonly container: string;

  constructor(container: string) {
    this.container = container;
  }

  /** Log lines since `since` (a Date), newest last. */
  async since(since: Date): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'logs',
        this.container,
        '--since',
        since.toISOString(),
      ]);
      return stdout.split('\n').filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}
