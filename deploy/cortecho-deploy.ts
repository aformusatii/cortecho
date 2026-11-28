import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  type AppliedMigration,
  assertUniqueEnvKey,
  backupMatchesImage,
  backupNames,
  backupSuffix,
  type Command,
  checkRollupVerdict,
  compareMigrations,
  DB_FILE_NAMES,
  DEFAULT_BACKUP_KEEP,
  DEFAULT_GITHUB_REPO,
  DEFAULT_IMAGE_REPO,
  digestFromRef,
  digestFromRepoDigests,
  EnvFileError,
  formatBackupAge,
  isDbFile,
  JOURNAL_PATH,
  newestBackup,
  type ParsedArgs,
  parseArgs,
  parseJournal,
  parseRollup,
  prGuardVerdict,
  readEnvValue,
  repoOfTagRef,
  revisionMismatch,
  selectBackupsToPrune,
  setEnvValue,
  shortDigest,
  stageDirFrom,
  targetRef,
  UsageError,
  usage,
  utcStamp,
} from './lib.ts';

const WAIT_TIMEOUT_SECONDS = 90;

interface RunOptions {
  cwd?: string;
  quiet?: boolean;
  allowFailure?: boolean;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

class DeployFailure extends Error {}

let activeRecovery: (() => void) | null = null;
let signalSeen = false;

function log(message: string): void {
  console.log(`[deploy] ${message}`);
}

function warn(message: string): void {
  console.warn(`[deploy] warning: ${message}`);
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@{}|=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function run(program: string, args: string[], options: RunOptions = {}): RunResult {
  log(`$ ${[program, ...args].map(quote).join(' ')}`);
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new DeployFailure(`cannot run ${program}: ${result.error.message}`);
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const status = result.status ?? 1;
  if (!options.quiet) {
    if (stdout.trim() !== '') process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
    if (stderr.trim() !== '') process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  }
  if (status !== 0 && !options.allowFailure) {
    const detail = lastLine(stderr) || lastLine(stdout) || `exit code ${status}`;
    throw new DeployFailure(`${program} ${args[0] ?? ''} failed: ${detail}`);
  }
  return { status, stdout, stderr };
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

function docker(args: string[], options: RunOptions = {}): RunResult {
  return run('docker', args, options);
}

function gh(args: string[], options: RunOptions = {}): RunResult {
  return run('gh', args, options);
}

function imageRepo(): string {
  return process.env.CORTECHO_IMAGE_REPO?.trim() || DEFAULT_IMAGE_REPO;
}

function githubRepo(): string {
  return process.env.CORTECHO_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
}

function githubOwner(): string {
  return githubRepo().split('/')[0] ?? githubRepo();
}

function readEnvFile(stageDir: string): string {
  return readFileSync(join(stageDir, '.env'), 'utf8');
}

function requireEnvImage(content: string): string {
  const image = readEnvValue(content, 'CORTECHO_IMAGE');
  if (!image) throw new DeployFailure('.env has no CORTECHO_IMAGE=');
  return image;
}

function loadStage(stageDir: string): string {
  if (!existsSync(join(stageDir, 'docker-compose.yml'))) {
    throw new DeployFailure(`${stageDir} has no docker-compose.yml; refusing to touch it`);
  }
  if (!existsSync(join(stageDir, '.env'))) {
    throw new DeployFailure(`${stageDir} has no .env; refusing to touch it`);
  }
  const content = readEnvFile(stageDir);
  assertUniqueEnvKey(content, 'CORTECHO_IMAGE');
  assertUniqueEnvKey(content, 'PREVIOUS_IMAGE');
  requireEnvImage(content);
  return content;
}

/**
 * Write through a symlinked `.env`, fsync before the atomic rename and clean
 * the temp file on every failure path.
 */
function writeEnvFile(stageDir: string, content: string): void {
  const linkPath = join(stageDir, '.env');
  const target = realpathSync(linkPath);
  const mode = statSync(target).mode;
  const tmp = `${target}.tmp-${process.pid}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    rmSync(tmp, { force: true });
  }
}

function compose(stageDir: string, args: string[], options: RunOptions = {}): RunResult {
  return docker(['compose', ...args], { cwd: stageDir, ...options });
}

function containerId(stageDir: string, all = false): string | null {
  const result = compose(stageDir, all ? ['ps', '-a', '-q'] : ['ps', '-q'], {
    quiet: true,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  const id = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return id ?? null;
}

/**
 * No buildx here: the Docker CLI in code-server may not have the plugin.
 * Pulling the tag first and reading RepoDigests gives the same index digest
 * (the one the attestation covers), and the pull is needed before the stop
 * anyway.
 */
function resolveDigest(ref: string): string {
  const repo = repoOfTagRef(ref);
  if (!repo) {
    throw new DeployFailure(`cannot determine the repository of ${ref}`);
  }
  const result = docker(['image', 'inspect', ref, '--format', '{{json .RepoDigests}}'], {
    quiet: true,
    allowFailure: true,
  });
  const digest = result.status === 0 ? digestFromRepoDigests(result.stdout, repo) : null;
  if (digest) return digest;
  const detail = lastLine(result.stderr) || result.stdout.trim() || 'no repo digest';
  throw new DeployFailure(`cannot resolve ${ref} to a ${repo}@sha256:… digest after pulling it: ${detail}`);
}

function verifyAttestation(repo: string, digest: string): void {
  const reference = `oci://${repo}@${digest}`;
  log(`verifying build provenance for ${reference}`);
  gh(['attestation', 'verify', reference, '-R', githubRepo()], { quiet: true });
}

interface PrView {
  isCrossRepository?: boolean | null;
  headRepositoryOwner?: { login?: string | null } | null;
  statusCheckRollup?: unknown;
  headRefOid?: string;
}

function checkPullRequest(pr: number): string | null {
  const result = gh(
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'isCrossRepository,headRepositoryOwner,headRefOid,statusCheckRollup',
    ],
    { quiet: true },
  );
  let data: PrView;
  try {
    data = JSON.parse(result.stdout) as PrView;
  } catch {
    throw new DeployFailure(`cannot parse gh pr view ${pr}`);
  }

  const guard = prGuardVerdict(data, githubOwner());
  if (!guard.ok) {
    throw new DeployFailure(`PR #${pr}: ${guard.reason}`);
  }
  if (typeof data.headRefOid === 'string') {
    log(`PR #${pr} head commit ${data.headRefOid}`);
  }

  const verdict = checkRollupVerdict(parseRollup(data.statusCheckRollup));
  if (verdict.failed.length > 0) {
    warn(`PR #${pr} required checks are not green: ${verdict.failed.join(', ')}`);
  }
  if (verdict.missing.length > 0) {
    warn(`PR #${pr} has no result yet for: ${verdict.missing.join(', ')}`);
  }
  if (verdict.ok) log(`PR #${pr} required checks are green`);
  return typeof data.headRefOid === 'string' ? data.headRefOid : null;
}

interface RunningState {
  id: string | null;
  digest: string | null;
  exists: boolean;
  running: boolean;
  health: string | null;
}

/**
 * The container's own inspect has no RepoDigests, so a non-digest
 * CORTECHO_IMAGE is resolved through the image id and `docker image inspect`.
 */
function runningState(stageDir: string, content: string): RunningState {
  const configuredDigest = digestFromRef(requireEnvImage(content));
  const id = containerId(stageDir, true);
  if (!id) {
    return { id: null, digest: configuredDigest, exists: false, running: false, health: null };
  }

  let running = false;
  let health: string | null = null;
  const stateResult = docker(['inspect', id, '--format', '{{json .State}}'], {
    quiet: true,
    allowFailure: true,
  });
  if (stateResult.status === 0) {
    try {
      const state = asRecord(JSON.parse(stateResult.stdout));
      running = state.Running === true;
      const status = asString(asRecord(state.Health).Status);
      health = status ?? null;
    } catch {
      // Leave the container as not running/unknown.
    }
  }

  let digest = configuredDigest;
  if (!digest) {
    const imageResult = docker(['inspect', id, '--format', '{{.Image}}'], {
      quiet: true,
      allowFailure: true,
    });
    const imageId = imageResult.stdout.trim();
    if (imageId !== '') {
      const repoResult = docker(['image', 'inspect', imageId, '--format', '{{json .RepoDigests}}'], {
        quiet: true,
        allowFailure: true,
      });
      if (repoResult.status === 0) {
        try {
          const values: unknown = JSON.parse(repoResult.stdout);
          if (Array.isArray(values)) {
            for (const value of values) {
              if (typeof value !== 'string') continue;
              const found = digestFromRef(value);
              if (found) {
                digest = found;
                break;
              }
            }
          }
        } catch {
          // No usable repo digest.
        }
      }
    }
  }

  return { id, digest, exists: true, running, health };
}

interface AppliedRead {
  applied: AppliedMigration[];
  warning: string | null;
}

function readAppliedMigrations(databasePath: string): AppliedRead {
  if (!existsSync(databasePath)) {
    log('no database yet; treating it as having no applied migrations');
    return { applied: [], warning: null };
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare('select id, hash, created_at from __drizzle_migrations order by id')
      .all() as Array<Record<string, unknown>>;
    return {
      applied: rows.map((row) => ({
        id: toNumber(row.id),
        hash: typeof row.hash === 'string' ? row.hash : null,
        createdAt: toNumber(row.created_at) ?? 0,
      })),
      warning: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return { applied: [], warning: null };
    return { applied: [], warning: message };
  } finally {
    database?.close();
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function journalFromImage(imageRef: string): string {
  const result = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', imageRef, JOURNAL_PATH], {
    quiet: true,
    allowFailure: true,
  });
  if (result.status !== 0) {
    const detail = lastLine(result.stderr) || 'docker run failed';
    throw new DeployFailure(`cannot read ${JOURNAL_PATH} from ${imageRef}: ${detail}`);
  }
  return result.stdout;
}

async function checkMigrations(stageDir: string, imageRef: string, yes: boolean): Promise<void> {
  const journalText = journalFromImage(imageRef);
  let journal: ReturnType<typeof parseJournal>;
  try {
    journal = parseJournal(journalText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployFailure(`cannot parse the migration journal in ${imageRef}: ${message}`);
  }

  const read = readAppliedMigrations(join(stageDir, 'data', 'app.db'));
  let needsConfirm = false;
  if (read.warning) {
    warn(`could not read the migration table before stopping: ${read.warning}`);
    warn('the migration comparison is unavailable; continuing needs --yes or an interactive confirmation');
    needsConfirm = true;
  } else {
    const comparison = compareMigrations(journal, read.applied);
    const appliedWhen = new Set(read.applied.map((migration) => migration.createdAt));
    const pending = journal.filter((entry) => !appliedWhen.has(entry.when));
    if (pending.length > 0) {
      log(`${pending.length} migration(s) in the image will run at startup`);
    }
    if (comparison.unknown.length > 0) {
      const names = comparison.unknown
        .map((migration) => {
          const when = new Date(migration.createdAt).toISOString();
          return migration.id === null ? `created ${when}` : `id ${migration.id}, created ${when}`;
        })
        .join('; ');
      warn('the database has migrations this image does not know:');
      warn(`  ${names}`);
      warn(
        'this image predates work already applied to the stage database; if you need to go back, use `cortecho-deploy rollback --restore-db` (data written since that backup is lost)',
      );
      needsConfirm = true;
    } else {
      log('migration check: the image knows every migration applied to the database');
    }
  }

  if (!needsConfirm) return;
  if (yes) {
    log('continuing because --yes was passed');
    return;
  }
  await confirm('Continue with the deploy?', false);
}

/** Rollback without --restore-db: report, never prompt or block. */
function reportMigrations(stageDir: string, imageRef: string): void {
  let journal: ReturnType<typeof parseJournal>;
  try {
    journal = parseJournal(journalFromImage(imageRef));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`cannot read the migration journal of ${imageRef}: ${message}`);
    return;
  }
  const read = readAppliedMigrations(join(stageDir, 'data', 'app.db'));
  if (read.warning) {
    warn(`cannot compare migrations: ${read.warning}`);
    return;
  }
  const comparison = compareMigrations(journal, read.applied);
  if (comparison.unknown.length === 0) {
    log(`migration check for ${imageRef}: the image knows every applied migration`);
    return;
  }
  warn(`${comparison.unknown.length} migration(s) applied to the database are unknown to ${imageRef}`);
  warn('rolling back without --restore-db may fail if that image cannot read the migrated schema');
  warn('use `cortecho-deploy rollback --restore-db` if you need the matching database');
}

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) {
    log('continuing because --yes was passed');
    return;
  }
  if (!process.stdin.isTTY) {
    throw new DeployFailure('refusing without a TTY; pass --yes to confirm');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new DeployFailure('aborted by the user');
    }
  } finally {
    readline.close();
  }
}

function dataFiles(stageDir: string): string[] {
  const dataDir = join(stageDir, 'data');
  if (!existsSync(dataDir)) throw new DeployFailure(`${dataDir} does not exist; cannot take a backup`);
  return readdirSync(dataDir).filter((name) => isDbFile(name));
}

/**
 * Copy into `<name>.partial`, verify every size, then rename to the final
 * directory. A crash leaves only a `.partial` directory, which is never
 * selected as a backup.
 */
function createBackup(stageDir: string, suffix: string): string {
  const files = dataFiles(stageDir);
  if (files.length === 0) {
    throw new DeployFailure(`${join(stageDir, 'data')} has no database files; refusing without a backup`);
  }
  const finalDir = join(stageDir, 'backups', `${utcStamp(new Date())}-${suffix}`);
  const partialDir = `${finalDir}.partial`;
  rmSync(partialDir, { recursive: true, force: true });
  mkdirSync(partialDir, { recursive: true });
  try {
    for (const file of files) {
      const source = join(stageDir, 'data', file);
      const target = join(partialDir, file);
      copyFileSync(source, target);
      if (statSync(source).size !== statSync(target).size) {
        throw new DeployFailure(`backup copy size mismatch for ${file}`);
      }
    }
    renameSync(partialDir, finalDir);
  } catch (error) {
    rmSync(partialDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployFailure(`backup failed: ${message}`);
  }
  log(`backup written: backups/${finalDir.split('/').pop()} (${files.join(', ')})`);
  return finalDir;
}

/**
 * Stage the copy under data/.restore-tmp, then rename each file over the live
 * one. Stale -wal/-shm/-journal files that the backup does not carry are
 * removed so SQLite cannot mix two generations of the database.
 */
function restoreBackup(stageDir: string, backupDir: string): void {
  const dataDir = join(stageDir, 'data');
  const present = DB_FILE_NAMES.filter((name) => existsSync(join(backupDir, name)));
  if (!present.includes('app.db')) {
    throw new DeployFailure(`backup ${backupDir} has no app.db`);
  }
  const tempDir = join(dataDir, '.restore-tmp');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  try {
    for (const name of present) {
      const source = join(backupDir, name);
      const target = join(tempDir, name);
      copyFileSync(source, target);
      if (statSync(source).size !== statSync(target).size) {
        throw new DeployFailure(`restore copy size mismatch for ${name}`);
      }
    }
    for (const name of present) {
      renameSync(join(tempDir, name), join(dataDir, name));
    }
    for (const name of DB_FILE_NAMES) {
      if (!present.includes(name)) rmSync(join(dataDir, name), { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployFailure(`database restore failed: ${message}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  try {
    const databaseOwner = statSync(join(dataDir, 'app.db'));
    const directoryOwner = statSync(dataDir);
    if (databaseOwner.uid !== directoryOwner.uid || databaseOwner.gid !== directoryOwner.gid) {
      warn(
        `restored app.db is owned ${databaseOwner.uid}:${databaseOwner.gid}, data/ is owned ${directoryOwner.uid}:${directoryOwner.gid}; chown app.db to the data/ owner`,
      );
    }
  } catch {
    // Ownership is only a warning; the restore itself already succeeded.
  }
  log(`database restored from backups/${backupDir.split('/').pop()}`);
}

function pruneBackups(stageDir: string, keep = DEFAULT_BACKUP_KEEP): void {
  const backupsDir = join(stageDir, 'backups');
  if (!existsSync(backupsDir)) return;
  const directories = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const remove = selectBackupsToPrune(directories, keep);
  for (const name of remove) {
    rmSync(join(backupsDir, name), { recursive: true, force: true });
    log(`pruned old backup: backups/${name}`);
  }
  log(`kept the newest ${backupNames(directories).length - remove.length} backup(s)`);
}

function reportDoctor(stageDir: string): void {
  const id = containerId(stageDir);
  if (!id) {
    warn('no running container; skipping `cortecho doctor`');
    return;
  }
  const result = docker(['exec', id, 'cortecho', 'doctor'], { allowFailure: true });
  if (result.status === 0) {
    log('doctor passed');
  } else {
    warn(`doctor exited ${result.status}; this is a report only (one known false alarm), not rolling back`);
  }
}

function pinnedImage(repo: string, digest: string): string {
  return `${repo}@${digest}`;
}

function imageRevision(imageRef: string): string | null {
  const result = docker(['image', 'inspect', imageRef, '--format', '{{json .Config.Labels}}'], {
    quiet: true,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  try {
    const labels = asRecord(JSON.parse(result.stdout));
    return asString(labels['org.opencontainers.image.revision']);
  } catch {
    return null;
  }
}

function checkPrRevision(prHeadOid: string | null, imageRef: string): void {
  if (!prHeadOid) return;
  const revision = imageRevision(imageRef);
  if (!revision) {
    warn('the PR image has no org.opencontainers.image.revision label; cannot compare it with the PR head');
    return;
  }
  if (revisionMismatch(prHeadOid, revision)) {
    warn(
      `the PR image is older than the PR head; wait for the image job (image ${revision}, PR head ${prHeadOid})`,
    );
  } else {
    log('the PR image matches the PR head commit');
  }
}

function stageNeedsHuman(backupDir: string | null, imageRef: string): void {
  console.error(
    `[deploy] stage needs a human; backup is at ${backupDir ?? '(none taken)'}, previous image ${imageRef}`,
  );
}

function recoverDeployment(
  stageDir: string,
  oldImage: string,
  previousImageBefore: string,
  backupDir: string | null,
): void {
  warn(`restoring the previous image (${oldImage})`);
  compose(stageDir, ['stop'], { allowFailure: true });
  if (backupDir) {
    try {
      restoreBackup(stageDir, backupDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(message);
      stageNeedsHuman(backupDir, oldImage);
      throw new DeployFailure(`database restore failed; not starting the container: ${message}`);
    }
  }

  try {
    const content = readEnvFile(stageDir);
    const restored = setEnvValue(
      setEnvValue(content, 'CORTECHO_IMAGE', oldImage),
      'PREVIOUS_IMAGE',
      previousImageBefore,
    );
    writeEnvFile(stageDir, restored);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`could not restore .env: ${message}`);
    stageNeedsHuman(backupDir, oldImage);
    throw new DeployFailure(`could not restore .env; not starting the container: ${message}`);
  }

  const up = compose(stageDir, ['up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS)], {
    allowFailure: true,
  });
  if (up.status === 0) {
    warn('previous image is healthy again');
    return;
  }
  stageNeedsHuman(backupDir, oldImage);
  throw new DeployFailure('previous image did not become healthy');
}

function installSignalHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (signalSeen) return;
      signalSeen = true;
      const recover = activeRecovery;
      activeRecovery = null;
      if (recover) {
        warn(`received ${signal} while the stage was stopped; recovering once`);
        try {
          recover();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[deploy] recovery failed: ${message}`);
        }
      } else {
        log(`received ${signal}; nothing in flight to recover`);
      }
      process.exit(130);
    });
  }
}

async function deployCommand(parsed: ParsedArgs, command: Command, stageDir: string): Promise<void> {
  const content = loadStage(stageDir);
  const repo = imageRepo();
  const ref = targetRef(command, repo);
  if (!ref) throw new DeployFailure('internal error: no image reference for this command');

  log(`target image: ${ref}`);
  const prHeadOid = command.kind === 'pr' ? checkPullRequest(command.number) : null;
  const currentImage = requireEnvImage(content);

  if (parsed.dryRun) {
    const state = runningState(stageDir, content);
    const oldShort = state.digest ? shortDigest(state.digest) : currentImage;
    log(`would pull ${ref} before touching the stage`);
    log(`would read the ${repo}@sha256:… digest from docker image inspect ${ref}`);
    log('would verify the build provenance of that digest');
    if (prHeadOid) log('would compare the PR image revision with the PR head');
    log(`would check migrations in ${ref} against data/app.db`);
    log(`would stop the stage only if it is not already healthy on that digest (old image: ${oldShort})`);
    log(`would copy data/app.db* to backups/<UTC stamp>-${backupSuffix(currentImage)}`);
    log(`would set PREVIOUS_IMAGE=${currentImage}`);
    log(`would set CORTECHO_IMAGE=${repo}@sha256:…`);
    log(`would run docker compose up -d --wait --wait-timeout ${WAIT_TIMEOUT_SECONDS}`);
    log('would run `cortecho doctor` and prune old backups');
    return;
  }

  // No buildx on the Docker client in code-server: pulling the tag first makes
  // `docker image inspect` return the repo digest (the index digest the
  // attestation covers), and the pull is needed before the stop anyway.
  docker(['pull', '--quiet', ref]);
  const digest = resolveDigest(ref);
  log(`target digest: ${digest}`);
  verifyAttestation(repo, digest);
  if (prHeadOid) checkPrRevision(prHeadOid, ref);

  const state = runningState(stageDir, content);
  if (state.digest === digest && state.exists && state.running && state.health === 'healthy') {
    log(`the running image already is ${shortDigest(digest)} and the container is healthy; nothing to do`);
    return;
  }
  if (state.digest === digest) {
    log('the image is already pinned, but the container is missing, stopped or unhealthy; starting it');
  }

  const target = pinnedImage(repo, digest);
  await checkMigrations(stageDir, target, parsed.yes);

  const previousEnv = readEnvFile(stageDir);
  const oldImage = requireEnvImage(previousEnv);
  const previousImageBefore = readEnvValue(previousEnv, 'PREVIOUS_IMAGE') ?? '';
  if (oldImage !== currentImage) {
    log(`CORTECHO_IMAGE changed while resolving; using ${oldImage} as the previous image`);
  }

  compose(stageDir, ['stop']);
  let backupDir: string | null = null;
  const recover = () => recoverDeployment(stageDir, oldImage, previousImageBefore, backupDir);
  activeRecovery = recover;
  try {
    backupDir = createBackup(stageDir, backupSuffix(oldImage));
    const nextEnv = setEnvValue(
      setEnvValue(previousEnv, 'PREVIOUS_IMAGE', oldImage),
      'CORTECHO_IMAGE',
      target,
    );
    writeEnvFile(stageDir, nextEnv);
    log(`CORTECHO_IMAGE=${target} written; PREVIOUS_IMAGE=${oldImage}`);
    compose(stageDir, ['up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS)]);
  } catch (error) {
    activeRecovery = null;
    const reason = error instanceof Error ? error.message : String(error);
    warn(`deployment failed: ${reason}`);
    recoverDeployment(stageDir, oldImage, previousImageBefore, backupDir);
    throw new DeployFailure(`deployment failed and was rolled back: ${reason}`);
  }
  activeRecovery = null;

  log('stage is healthy');
  reportDoctor(stageDir);
  pruneBackups(stageDir);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportRollbackFailure(
  stageDir: string,
  currentImage: string,
  previousImage: string,
  chosenBackup: string | null,
  preRollbackBackup: string | null,
): void {
  warn('rollback started but the container did not become healthy');
  warn(
    `state: CORTECHO_IMAGE=${previousImage}, PREVIOUS_IMAGE=${currentImage}; container stopped or unhealthy; database ${
      chosenBackup ? `restored from backups/${chosenBackup.split('/').pop()}` : 'not restored'
    }`,
  );
  warn(
    `manual recovery: set CORTECHO_IMAGE=${currentImage} and PREVIOUS_IMAGE=${previousImage} in ${join(stageDir, '.env')}, then ${
      preRollbackBackup ? `copy backups/${preRollbackBackup.split('/').pop()}/* over data/ and ` : ''
    }run docker compose up -d --wait`,
  );
}

async function rollbackCommand(parsed: ParsedArgs, stageDir: string): Promise<void> {
  if (parsed.command.kind !== 'rollback') throw new DeployFailure('internal error: not a rollback');
  const content = loadStage(stageDir);
  const currentImage = requireEnvImage(content);
  const previousImage = readEnvValue(content, 'PREVIOUS_IMAGE');
  if (!previousImage) {
    throw new DeployFailure('PREVIOUS_IMAGE is empty; there is no image to roll back to');
  }
  const currentDigest = digestFromRef(currentImage);
  const previousDigest = digestFromRef(previousImage);
  if (currentDigest && previousDigest && currentDigest === previousDigest) {
    log(`the previous image already is ${shortDigest(previousDigest)}; nothing to do`);
    return;
  }

  let chosenBackup: string | null = null;
  if (parsed.command.restoreDb) {
    const backupsDir = join(stageDir, 'backups');
    const entries = existsSync(backupsDir)
      ? readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
    const name = newestBackup(entries);
    if (!name) throw new DeployFailure('--restore-db was requested but backups/ has no backup');
    chosenBackup = join(backupsDir, name);
    const age = formatBackupAge(name) ?? 'unknown age';
    const matches = backupMatchesImage(name, currentImage);
    log(`restore backup: ${name} (age ${age})`);
    log(
      `backup suffix matches the image being left (${backupSuffix(currentImage)}): ${matches ? 'yes' : 'no'}`,
    );
    warn(`--restore-db will replace data/app.db* with backups/${name}`);
    warn('data written since that backup will be lost; a pre-rollback copy is taken first');
    if (!parsed.dryRun) await confirm('Restore the database too?', parsed.yes);
  }

  if (parsed.dryRun) {
    log(`would pull ${previousImage}`);
    if (!parsed.command.restoreDb) log(`would compare migrations of ${previousImage} with data/app.db`);
    log(`would stop the stage (current image: ${currentImage})`);
    if (chosenBackup)
      log(`would copy data/app.db* to backups/<stamp>-pre-rollback, then restore ${chosenBackup}`);
    log(`would set CORTECHO_IMAGE=${previousImage}`);
    log(`would set PREVIOUS_IMAGE=${currentImage}`);
    log(`would start with docker compose up -d --wait --wait-timeout ${WAIT_TIMEOUT_SECONDS}`);
    return;
  }

  ensureImage(previousImage);
  if (!parsed.command.restoreDb) reportMigrations(stageDir, previousImage);

  compose(stageDir, ['stop']);
  let preRollbackBackup: string | null = null;
  const recover = () => recoverDeployment(stageDir, currentImage, previousImage, preRollbackBackup);
  activeRecovery = recover;
  try {
    if (chosenBackup) {
      preRollbackBackup = createBackup(stageDir, 'pre-rollback');
      restoreBackup(stageDir, chosenBackup);
    }
    const nextEnv = setEnvValue(
      setEnvValue(readEnvFile(stageDir), 'CORTECHO_IMAGE', previousImage),
      'PREVIOUS_IMAGE',
      currentImage,
    );
    writeEnvFile(stageDir, nextEnv);
    log(`CORTECHO_IMAGE=${previousImage} written; PREVIOUS_IMAGE=${currentImage}`);
    compose(stageDir, ['up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS)]);
  } catch (error) {
    activeRecovery = null;
    const reason = messageOf(error);
    if (chosenBackup && reason.includes('database restore failed')) {
      warn(reason);
      stageNeedsHuman(chosenBackup, previousImage);
      throw new DeployFailure(`rollback stopped after a failed database restore: ${reason}`);
    }
    if (reason.includes('backup failed')) {
      warn(reason);
      recoverDeployment(stageDir, currentImage, previousImage, null);
      throw new DeployFailure(`rollback stopped before restoring the database: ${reason}`);
    }
    reportRollbackFailure(stageDir, currentImage, previousImage, chosenBackup, preRollbackBackup);
    throw new DeployFailure(`rollback failed: ${reason}`);
  }
  activeRecovery = null;

  log('rollback is healthy');
  reportDoctor(stageDir);
}

function ensureImage(ref: string): void {
  const local = docker(['image', 'inspect', ref], { quiet: true, allowFailure: true });
  if (local.status === 0) return;
  docker(['pull', '--quiet', ref]);
}

function statusCommand(stageDir: string): void {
  const content = loadStage(stageDir);
  const configured = requireEnvImage(content);
  const previous = readEnvValue(content, 'PREVIOUS_IMAGE');
  log(`CORTECHO_IMAGE=${configured}`);
  log(`PREVIOUS_IMAGE=${previous === null || previous === '' ? '(none)' : previous}`);

  const id = containerId(stageDir);
  if (!id) {
    log('container: not running');
  } else {
    const result = docker(['inspect', id], { quiet: true });
    const container = parseInspect(result.stdout);
    if (!container) throw new DeployFailure('cannot parse docker inspect output');
    const config = asRecord(container.Config);
    const labels = asRecord(config.Labels);
    const state = asRecord(container.State);
    const health = asRecord(state.Health);
    const image = asString(config.Image) ?? '(unknown)';
    const imageId = asString(container.Image);
    let digest = digestFromRef(image);
    if (!digest && imageId) {
      const repoResult = docker(['image', 'inspect', imageId, '--format', '{{json .RepoDigests}}'], {
        quiet: true,
        allowFailure: true,
      });
      if (repoResult.status === 0) {
        try {
          const values: unknown = JSON.parse(repoResult.stdout);
          if (Array.isArray(values)) {
            for (const value of values) {
              if (typeof value === 'string') {
                const found = digestFromRef(value);
                if (found) {
                  digest = found;
                  break;
                }
              }
            }
          }
        } catch {
          // No usable repo digest.
        }
      }
    }
    log(`running image: ${image}`);
    log(`running digest: ${digest ?? '(local image, no registry digest)'}`);
    log(`revision: ${label(labels, 'org.opencontainers.image.revision')}`);
    log(`pr: ${label(labels, 'io.github.cortecho.pr')}`);
    log(`tree: ${label(labels, 'io.github.cortecho.tree')}`);
    log(`created: ${label(labels, 'org.opencontainers.image.created')}`);
    const healthStatus = asString(health.Status);
    log(`health: ${healthStatus ?? 'none'}`);
    if (!healthStatus) {
      warn('the running image has no HEALTHCHECK; compose --wait cannot see its health');
    }
  }

  const backupsDir = join(stageDir, 'backups');
  const entries = existsSync(backupsDir)
    ? readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const latest = newestBackup(entries);
  log(`newest backup: ${latest ?? '(none)'}`);
}

function label(labels: Record<string, unknown>, name: string): string {
  return asString(labels[name]) ?? '(none)';
}

function parseInspect(output: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return null;
    const first = parsed[0];
    return asRecord(first);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function main(): Promise<void> {
  installSignalHandlers();
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[deploy] error: ${error.message}`);
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (parsed.help) {
    console.log(usage());
    return;
  }

  const stageDir = stageDirFrom({
    dir: parsed.dir,
    envDir: process.env.CORTECHO_STAGE_DIR,
    invokedAs: process.env.CORTECHO_DEPLOY_INVOKED_AS,
    cwd: process.cwd(),
  });
  log(`stage folder: ${stageDir}`);

  switch (parsed.command.kind) {
    case 'status':
      statusCommand(stageDir);
      return;
    case 'rollback':
      await rollbackCommand(parsed, stageDir);
      return;
    case 'pr':
    case 'main':
    case 'version':
      await deployCommand(parsed, parsed.command, stageDir);
      return;
  }
}

main().catch((error: unknown) => {
  if (error instanceof DeployFailure || error instanceof UsageError || error instanceof EnvFileError) {
    console.error(`[deploy] error: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`[deploy] error: ${error.message}`);
    if (error.stack) console.error(error.stack);
  } else {
    console.error(`[deploy] error: ${String(error)}`);
  }
  process.exitCode = 1;
});
