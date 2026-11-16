import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ShellToolScript } from '../../config.ts';
import type { Tool } from '../registry.ts';

const MAX_OUTPUT_CHARS = 2000;

/**
 * Runs one of a fixed set of scripts from SHELL_TOOL_SCRIPTS, e.g.
 *   {"backup_status":{"path":"/app/scripts/backup-status.sh","description":"Reports the last backup"}}
 * Destructive by definition: it runs only when "run_script" is listed in
 * TOOLS_ALLOW_DESTRUCTIVE. The model picks a NAME; it never passes arguments
 * or a command line, and the script runs without a shell.
 *
 * Inside Docker the scripts must be mounted into the container. Never give
 * this tool access to adb or to the Echo's update key.
 */
export function runScriptTool(scripts: Record<string, ShellToolScript>): Tool | null {
  const names = Object.keys(scripts);
  if (names.length === 0) return null;
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script?.path !== 'string' || !path.isAbsolute(script.path)) {
      throw new Error(`SHELL_TOOL_SCRIPTS.${name}.path must be an absolute path`);
    }
  }
  const catalogue = names
    .map((name) => `${name}${scripts[name]?.description ? ` (${scripts[name]?.description})` : ''}`)
    .join('; ');

  return {
    name: 'run_script',
    description: `Runs a configured home-server script and returns its output. Scripts: ${catalogue}.`,
    destructive: true,
    parameters: {
      type: 'object',
      properties: { script: { type: 'string', enum: names } },
      required: ['script'],
      additionalProperties: false,
    },
    handler: (args, { signal }) =>
      new Promise((resolve, reject) => {
        const script = scripts[String(args.script)];
        if (!script) {
          reject(new Error(`unknown script "${String(args.script)}"`));
          return;
        }
        execFile(
          script.path,
          [],
          { signal, timeout: 30_000, maxBuffer: 64 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`${error.message} ${stderr}`.trim().slice(0, MAX_OUTPUT_CHARS)));
              return;
            }
            resolve({ output: stdout.slice(0, MAX_OUTPUT_CHARS) });
          },
        );
      }),
  };
}
