import { dirname, resolve } from 'node:path';

/**
 * Pure helpers for cortecho-deploy. Nothing in this file touches the
 * filesystem, Docker or GitHub, so every rule here is unit-testable.
 */

export const DEFAULT_IMAGE_REPO = 'ghcr.io/aformusatii/cortecho';
export const DEFAULT_GITHUB_REPO = 'aformusatii/cortecho';
export const REQUIRED_CHECKS = ['ci', 'image', 'integration', 'pr-title'] as const;
export const DEFAULT_BACKUP_KEEP = 5;
export const JOURNAL_PATH = '/app/apps/api/drizzle/meta/_journal.json';
export const DB_FILE_NAMES = ['app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal'] as const;
// A half-copied backup keeps the `.partial` suffix and must never be selected
// as a backup or pruned as one.
export const BACKUP_PATTERN = /^\d{8}T\d{6}Z-(?!.*\.partial$).+$/;

export type Command =
  | { kind: 'pr'; number: number }
  | { kind: 'main' }
  | { kind: 'version'; version: string }
  | { kind: 'rollback'; restoreDb: boolean }
  | { kind: 'status' };

export interface ParsedArgs {
  command: Command;
  dir: string | undefined;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export function usage(): string {
  return [
    'Usage: cortecho-deploy <command> [options]',
    '',
    'Commands:',
    '  pr <N>                  deploy the current image of pull request N (:pr-N)',
    '  main                    deploy the current :main image',
    '  version <X.Y.Z>         deploy a released version',
    '  rollback [--restore-db] deploy the previous image, optionally its database backup',
    '  status                  show the running image, labels, health and newest backup',
    '',
    'Options:',
    '  --dir <path>            stage folder (default: the folder the symlink lives in, or cwd)',
    '  --dry-run               print every step and change nothing',
    '  --yes                   answer the data-loss / migration confirmations with yes',
    '  -h, --help              show this help',
  ].join('\n');
}

const SEMVER = /^\d+\.\d+\.\d+$/;

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes('-h') || argv.includes('--help')) {
    return {
      command: { kind: 'status' },
      dir: undefined,
      dryRun: false,
      yes: false,
      help: true,
    };
  }

  let dir: string | undefined;
  let dryRun = false;
  let yes = false;
  let restoreDb = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--restore-db') {
      restoreDb = true;
    } else if (arg === '--dir') {
      dir = takeValue(argv, i, '--dir');
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length);
      if (value === '') throw new UsageError('--dir needs a value');
      dir = value;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [name, ...rest] = positional;
  if (name === undefined) throw new UsageError('missing command');
  if (restoreDb && name !== 'rollback') {
    throw new UsageError('--restore-db is only valid with rollback');
  }

  switch (name) {
    case 'pr': {
      if (rest.length !== 1) throw new UsageError('pr needs one PR number');
      const raw = rest[0];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) <= 0) {
        throw new UsageError(`invalid PR number: ${raw ?? ''}`);
      }
      return { command: { kind: 'pr', number: Number(raw) }, dir, dryRun, yes, help: false };
    }
    case 'main': {
      if (rest.length !== 0) throw new UsageError('main takes no arguments');
      return { command: { kind: 'main' }, dir, dryRun, yes, help: false };
    }
    case 'version': {
      if (rest.length !== 1) throw new UsageError('version needs one X.Y.Z version');
      const raw = rest[0];
      if (raw === undefined || !SEMVER.test(raw)) {
        throw new UsageError(`invalid version: ${raw ?? ''} (expected X.Y.Z)`);
      }
      return { command: { kind: 'version', version: raw }, dir, dryRun, yes, help: false };
    }
    case 'rollback': {
      if (rest.length !== 0) throw new UsageError('rollback takes no arguments');
      return { command: { kind: 'rollback', restoreDb }, dir, dryRun, yes, help: false };
    }
    case 'status': {
      if (rest.length !== 0) throw new UsageError('status takes no arguments');
      if (restoreDb) throw new UsageError('--restore-db is only valid with rollback');
      return { command: { kind: 'status' }, dir, dryRun, yes, help: false };
    }
    default:
      throw new UsageError(`unknown command: ${name}`);
  }
}

export function targetRef(command: Command, repo = DEFAULT_IMAGE_REPO): string | null {
  switch (command.kind) {
    case 'pr':
      return `${repo}:pr-${command.number}`;
    case 'main':
      return `${repo}:main`;
    case 'version':
      return `${repo}:${command.version}`;
    case 'rollback':
    case 'status':
      return null;
  }
}

export function stageDirFrom(opts: {
  dir?: string | undefined;
  envDir?: string | undefined;
  invokedAs?: string | undefined;
  cwd: string;
}): string {
  const chosen =
    opts.dir ??
    (opts.envDir || undefined) ??
    (opts.invokedAs ? dirname(resolve(opts.cwd, opts.invokedAs)) : opts.cwd);
  return resolve(opts.cwd, chosen);
}

export class EnvFileError extends Error {}

export function countEnvKey(content: string, key: string): number {
  const lineRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escapeRegExp(key)}[ \\t]*=`);
  let count = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    if (lineRe.test(rawLine)) count += 1;
  }
  return count;
}

export function assertUniqueEnvKey(content: string, key: string): void {
  const count = countEnvKey(content, key);
  if (count > 1) {
    throw new EnvFileError(`duplicate ${key} keys in .env (${count}); fix the file before deploying`);
  }
}

export function readEnvValue(content: string, key: string): string | null {
  const lineRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escapeRegExp(key)}[ \\t]*=(.*)$`);
  for (const rawLine of content.split(/\r?\n/)) {
    const match = lineRe.exec(rawLine);
    if (!match) continue;
    let value = (match[1] ?? '').trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
      }
    }
    // An unquoted dotenv value ends at whitespace followed by `#`; the
    // comment stays in the file but is not part of the value.
    value = value.replace(/[ \t]+#.*$/, '').trimEnd();
    return value;
  }
  return null;
}

/**
 * Replace (or append) one KEY=value line and leave every other line,
 * comment and blank line exactly as it was. Inline comments on the replaced
 * line are kept when they are separated from the value by whitespace.
 */
export function setEnvValue(content: string, key: string, value: string): string {
  assertUniqueEnvKey(content, key);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalEol = content.endsWith(eol);
  const lines = content.split(eol);
  if (hadFinalEol) lines.pop();

  const lineRe = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${escapeRegExp(key)}[ \\t]*=)(.*)$`);
  let found = false;
  const next = lines.map((line) => {
    const match = lineRe.exec(line);
    if (!match || found) return line;
    found = true;
    const prefix = match[1] ?? '';
    const oldRest = match[2] ?? '';
    const inline = /[ \t]+#.*$/.exec(oldRest);
    return `${prefix}${value}${inline ? inline[0] : ''}`;
  });
  if (!found) next.push(`${key}=${value}`);

  const joined = next.join(eol);
  return hadFinalEol ? `${joined}${eol}` : joined;
}

export function digestFromRef(ref: string): string | null {
  const match = /@(sha256:[0-9a-f]{64})$/.exec(ref.trim());
  return match?.[1] ?? null;
}

export function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function shortDigest(digest: string, length = 12): string {
  const value = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return value.slice(0, length);
}

export function isDbFile(name: string): boolean {
  return (DB_FILE_NAMES as readonly string[]).includes(name);
}

export function backupSuffix(oldImage: string): string {
  const digest = digestFromRef(oldImage);
  if (digest) return shortDigest(digest);
  const cleaned = oldImage
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

export function utcStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    'T',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    'Z',
  ].join('');
}

export function backupName(date: Date, oldImage: string): string {
  return `${utcStamp(date)}-${backupSuffix(oldImage)}`;
}

export function backupTimestamp(name: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBackupAge(name: string, now = new Date()): string | null {
  const created = backupTimestamp(name);
  if (!created) return null;
  let seconds = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function backupMatchesImage(name: string, image: string): boolean {
  const suffix = name.replace(/^\d{8}T\d{6}Z-/, '');
  return suffix === backupSuffix(image);
}

export function backupNames(entries: string[]): string[] {
  return entries
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort()
    .reverse();
}

export function newestBackup(entries: string[]): string | null {
  return backupNames(entries)[0] ?? null;
}

/**
 * Newest first by the sortable UTC stamp. Only names matching the backup
 * pattern are considered, so the old flat `app.db.bak-*` files are never
 * touched.
 */
export function selectBackupsToPrune(entries: string[], keep = DEFAULT_BACKUP_KEEP): string[] {
  return backupNames(entries).slice(keep);
}

/**
 * The tag reference (`repo:tag`) and the image repository (`repo`) are needed
 * together: the repository prefix selects the right entry from
 * `docker image inspect <ref> --format '{{json .RepoDigests}}'`.
 */
export function repoOfTagRef(ref: string): string | null {
  const normalized = ref.trim();
  const lastSlash = normalized.lastIndexOf('/');
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon <= lastSlash) return null;
  return normalized.slice(0, lastColon);
}

export function digestFromRepoDigests(output: string, repo: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (typeof entry !== 'string' || !entry.startsWith(`${repo}@`)) continue;
    const digest = digestFromRef(entry);
    if (digest) return digest;
  }
  return null;
}

export interface PrGuardView {
  isCrossRepository?: boolean | null;
  headRepositoryOwner?: { login?: string | null } | null;
}

export interface PrGuardVerdict {
  ok: boolean;
  reason: string | null;
}

export function prGuardVerdict(view: PrGuardView, repoOwner: string): PrGuardVerdict {
  if (view.isCrossRepository !== false) {
    return { ok: false, reason: 'the PR is from a fork; fork images are never deployed to stage' };
  }
  const login = view.headRepositoryOwner?.login;
  if (typeof login !== 'string' || login === '') {
    return { ok: false, reason: 'cannot determine the PR head repository owner' };
  }
  if (login.toLowerCase() !== repoOwner.toLowerCase()) {
    return {
      ok: false,
      reason: `the PR head owner is ${login}, not ${repoOwner}`,
    };
  }
  return { ok: true, reason: null };
}

export function revisionMismatch(prHeadOid: string | null, imageRevision: string | null): boolean {
  return prHeadOid !== null && imageRevision !== null && prHeadOid !== imageRevision;
}

export interface JournalEntry {
  when: number;
  tag: string | null;
  idx: number | null;
}

export function parseJournal(text: string): JournalEntry[] {
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null) throw new Error('journal is not an object');
  const entries = (data as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) throw new Error('journal has no entries array');
  const result: JournalEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.when !== 'number' || !Number.isFinite(record.when)) continue;
    result.push({
      when: record.when,
      tag: typeof record.tag === 'string' ? record.tag : null,
      idx: typeof record.idx === 'number' ? record.idx : null,
    });
  }
  return result;
}

export interface AppliedMigration {
  id: number | null;
  hash: string | null;
  createdAt: number;
}

export interface MigrationComparison {
  unknown: AppliedMigration[];
  knownCount: number;
}

/**
 * Drizzle writes the journal entry's `when` into `__drizzle_migrations`.
 * A database row whose timestamp the target image's journal does not know
 * means the image predates a migration already applied here.
 */
export function compareMigrations(journal: JournalEntry[], applied: AppliedMigration[]): MigrationComparison {
  const known = new Set(journal.map((entry) => entry.when));
  const unknown = applied.filter((migration) => !known.has(migration.createdAt));
  return { unknown, knownCount: journal.length };
}

const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const GREEN_STATES = new Set(['SUCCESS', 'NEUTRAL']);

export interface RollupCheck {
  name: string;
  status: string | null;
  conclusion: string | null;
  state: string | null;
}

export function parseRollup(value: unknown): RollupCheck[] {
  if (!Array.isArray(value)) return [];
  const result: RollupCheck[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : record.context;
    if (typeof name !== 'string') continue;
    result.push({
      name,
      status: typeof record.status === 'string' ? record.status.toUpperCase() : null,
      conclusion: typeof record.conclusion === 'string' ? record.conclusion.toUpperCase() : null,
      state: typeof record.state === 'string' ? record.state.toUpperCase() : null,
    });
  }
  return result;
}

export interface RollupVerdict {
  ok: boolean;
  failed: string[];
  missing: string[];
}

/**
 * Only the checks the ruleset requires matter. A check is green when it has
 * completed successfully (or was skipped/neutral); anything else, including
 * still-running, is reported.
 */
export function checkRollupVerdict(
  checks: RollupCheck[],
  required: readonly string[] = REQUIRED_CHECKS,
): RollupVerdict {
  const byName = new Map<string, RollupCheck>();
  for (const check of checks) byName.set(check.name.toLowerCase(), check);

  const failed: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const check = byName.get(name.toLowerCase());
    if (!check) {
      missing.push(name);
      continue;
    }
    if (check.status !== null && check.status !== 'COMPLETED') {
      failed.push(`${name} (${check.status.toLowerCase()})`);
      continue;
    }
    if (check.conclusion !== null && !GREEN_CONCLUSIONS.has(check.conclusion)) {
      failed.push(`${name} (${check.conclusion.toLowerCase()})`);
      continue;
    }
    if (check.state !== null && !GREEN_STATES.has(check.state)) {
      failed.push(`${name} (${check.state.toLowerCase()})`);
    }
  }
  return { ok: failed.length === 0 && missing.length === 0, failed, missing };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
