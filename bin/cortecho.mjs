#!/usr/bin/env node
/**
 * The `cortecho` command. Only `doctor` exists today. Node 24 runs the
 * TypeScript entrypoint directly, so there is no build step for the CLI.
 *
 *   cortecho doctor [--json] [--say "text"]
 */
import { fileURLToPath } from 'node:url';

const [, , command, ...rest] = process.argv;

if (!command || command === '--help' || command === '-h') {
  console.log(`usage: cortecho <command>

Commands:
  doctor [--json] [--say "text"]   Read-only configuration and link checks

Run inside the container: docker compose exec app cortecho doctor`);
  process.exit(command ? 0 : 2);
}

if (command === 'doctor') {
  // Keep the remaining arguments for the doctor script.
  process.argv = [process.argv[0], 'doctor', ...rest];
  await import(fileURLToPath(new URL('../apps/api/src/scripts/doctor.ts', import.meta.url)));
} else {
  console.error(`cortecho: unknown command "${command}". Try: cortecho --help`);
  process.exit(2);
}
