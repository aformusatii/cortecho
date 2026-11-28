import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_PATTERN, readEnvValue } from './lib.ts';

/**
 * These tests run the real deploy entrypoint against a throwaway stage folder
 * with fake `docker` and `gh` executables on PATH. They never reach a Docker
 * daemon or GitHub. Gated so `npm test` stays network/Docker-free:
 *
 *   DEPLOY_INTEGRATION=1 npx vitest run --project deploy
 */
const enabled = process.env.DEPLOY_INTEGRATION === '1';
const REPO = 'ghcr.io/test/cortecho';
const GITHUB_REPO = 'test/cortecho';
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const PRIOR_DIGEST = `sha256:${'3'.repeat(64)}`;
const OLD_IMAGE = `${REPO}@${OLD_DIGEST}`;
const NEW_IMAGE = `${REPO}@${NEW_DIGEST}`;
const PRIOR_IMAGE = `${REPO}@${PRIOR_DIGEST}`;
const scriptPath = fileURLToPath(new URL('./cortecho-deploy.ts', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./test', import.meta.url));

interface Stage {
  root: string;
  dir: string;
  env: NodeJS.ProcessEnv;
  dockerLog: string;
  ghLog: string;
  originalDb: Buffer;
}

let temporaryRoot: string;
let stage: Stage;

function makeBin(): string {
  const bin = join(temporaryRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['docker', 'gh']) {
    const target = join(bin, name);
    copyFileSync(join(fixtureDir, `fake-${name}`), target);
    chmodSync(target, 0o755);
  }
  return bin;
}

interface StageOptions {
  current?: string;
  previous?: string;
  backups?: string[];
  failUpOnce?: boolean;
  health?: string;
  running?: boolean;
  imageRevision?: string;
  prHeadOid?: string;
  crossRepository?: boolean;
  headOwner?: string;
}

function makeStage(options: StageOptions = {}): Stage {
  const root = mkdtempSync(join(temporaryRoot, 'stage-'));
  const dir = join(root, 'cortecho');
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  app:\n    image: example\n');
  writeFileSync(
    join(dir, '.env'),
    [
      '# stage .env (fake)',
      `STAGE_DIR=${dir}`,
      'APP_PORT=8063',
      `CORTECHO_IMAGE=${options.current ?? OLD_IMAGE}`,
      `PREVIOUS_IMAGE=${options.previous ?? ''}`,
      'CORTECHO_SECRET_KEY=not-a-real-secret',
      '',
    ].join('\n'),
  );

  const dbPath = join(dir, 'data', 'app.db');
  const db = new DatabaseSync(dbPath);
  db.exec('create table __drizzle_migrations (id integer primary key, hash text, created_at numeric)');
  db.close();
  const originalDb = readFileSync(dbPath);

  for (const name of options.backups ?? []) {
    mkdirSync(join(dir, 'backups', name), { recursive: true });
    writeFileSync(join(dir, 'backups', name, 'app.db'), `backup ${name}`);
  }

  const revision = options.imageRevision ?? 'deadbeef';
  const labels = {
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.created': '2026-11-28T00:00:00Z',
    'io.github.cortecho.pr': '12',
    'io.github.cortecho.tree': 'tree123',
  };
  const journal = join(root, 'journal.json');
  writeFileSync(journal, JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }));
  const inspect = join(root, 'inspect.json');
  writeFileSync(
    inspect,
    JSON.stringify([
      {
        Image: 'sha256:fake-image-id',
        Config: {
          Image: NEW_IMAGE,
          Labels: labels,
        },
        State: {
          Running: options.running !== false,
          ...(options.health === 'none' ? {} : { Health: { Status: options.health ?? 'healthy' } }),
        },
      },
    ]),
  );
  const pr = join(root, 'pr.json');
  writeFileSync(
    pr,
    JSON.stringify({
      isCrossRepository: options.crossRepository === true,
      headRepositoryOwner: { login: options.headOwner ?? 'test' },
      headRefOid: options.prHeadOid ?? 'deadbeef',
      statusCheckRollup: ['ci', 'image', 'integration', 'pr-title'].map((name) => ({
        name,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      })),
    }),
  );

  const dockerLog = join(root, 'docker.log');
  const ghLog = join(root, 'gh.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${makeBin()}:${process.env.PATH ?? ''}`,
    CORTECHO_IMAGE_REPO: REPO,
    CORTECHO_GITHUB_REPO: GITHUB_REPO,
    CORTECHO_DEPLOY_INVOKED_AS: '',
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_GH_LOG: ghLog,
    FAKE_JOURNAL_FILE: journal,
    FAKE_INSPECT_FILE: inspect,
    FAKE_PR_FILE: pr,
    FAKE_STAGE_DIR: dir,
    FAKE_UP_MARKER: join(root, 'up-happened'),
    FAKE_FAIL_UP_ONCE: options.failUpOnce ? '1' : '0',
    FAKE_HEALTH_STATUS: options.health ?? 'healthy',
    FAKE_RUNNING: options.running === false ? '0' : '1',
    FAKE_REPO_DIGESTS: JSON.stringify([NEW_IMAGE]),
    FAKE_LABELS_JSON: JSON.stringify(labels),
  };
  delete env.CORTECHO_STAGE_DIR;

  return { root, dir, env, dockerLog, ghLog, originalDb };
}

function deploy(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(process.execPath, [scriptPath, '--dir', stage.dir, ...args], {
    cwd: stage.root,
    encoding: 'utf8',
    env: { ...stage.env, ...extraEnv },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function envValue(key: string): string | null {
  return readEnvValue(readFileSync(join(stage.dir, '.env'), 'utf8'), key);
}

function dockerCalls(): string {
  return existsSync(stage.dockerLog) ? readFileSync(stage.dockerLog, 'utf8') : '';
}

function backupDirectories(): string[] {
  return readdirSync(join(stage.dir, 'backups'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'cortecho-deploy-'));
});

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('cortecho-deploy (throwaway stage, fake docker/gh)', () => {
  it('deploys a PR image, writes .env, backs up the DB and keeps five backups', () => {
    const oldBackups = Array.from({ length: 6 }, (_, index) => `2020010${index + 1}T000000Z-old${index + 1}`);
    stage = makeStage({ backups: oldBackups });
    mkdirSync(join(stage.dir, 'backups', '20200101T000000Z-stale.partial'), { recursive: true });
    writeFileSync(join(stage.dir, 'data', 'app.db.bak-keep'), 'old flat backup');

    const result = deploy(['pr', '12']);
    expect(result.status, result.output).toBe(0);
    expect(envValue('CORTECHO_IMAGE')).toBe(NEW_IMAGE);
    expect(envValue('PREVIOUS_IMAGE')).toBe(OLD_IMAGE);

    const backups = backupDirectories();
    expect(backups).toHaveLength(5);
    const newest = backups[backups.length - 1];
    expect(newest).toMatch(BACKUP_PATTERN);
    expect(newest).toContain('111111111111');
    expect(readFileSync(join(stage.dir, 'backups', newest ?? '', 'app.db'))).toEqual(stage.originalDb);
    expect(readdirSync(join(stage.dir, 'backups', newest ?? '')).sort()).toEqual(['app.db']);
    expect(readdirSync(join(stage.dir, 'backups')).filter((name) => name.endsWith('.partial'))).toEqual([
      '20200101T000000Z-stale.partial',
    ]);
    expect(existsSync(join(stage.dir, 'data', 'app.db.bak-keep'))).toBe(true);
    expect(backups).not.toContain('20200101T000000Z-old1');
    expect(backups).not.toContain('20200102T000000Z-old2');
    expect(backups).toContain('20200103T000000Z-old3');

    const calls = dockerCalls();
    expect(calls).toContain('docker compose stop');
    expect(calls).toContain('docker compose up -d --wait --wait-timeout 90');
    expect(calls).toContain(`docker pull --quiet ${REPO}:pr-12`);
    expect(calls.indexOf(`docker pull --quiet ${REPO}:pr-12`)).toBeLessThan(
      calls.indexOf('docker compose stop'),
    );
    expect(calls).toContain(`docker image inspect ${REPO}:pr-12 --format {{json .RepoDigests}}`);
    expect(calls).not.toContain('docker buildx');
    expect(calls).not.toContain('docker manifest inspect');
    expect(calls).not.toContain('docker image prune');
    expect(calls).not.toContain('docker rmi');
    expect(readFileSync(stage.ghLog, 'utf8')).toContain('gh attestation verify');
  });

  it('stops without touching anything when the digest is already running', () => {
    stage = makeStage({ current: NEW_IMAGE });

    const result = deploy(['main']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('nothing to do');
    expect(dockerCalls()).not.toContain('docker compose stop');
    expect(backupDirectories()).toHaveLength(0);
  });

  it('resolves a non-digest CORTECHO_IMAGE through the container and image inspect', () => {
    stage = makeStage({ current: 'cortecho:dev' });

    const result = deploy(['main']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('nothing to do');
    expect(dockerCalls()).toContain('docker inspect fake-container-id --format {{.Image}}');
    expect(dockerCalls()).toContain(
      'docker image inspect sha256:fake-image-id --format {{json .RepoDigests}}',
    );
    expect(dockerCalls()).not.toContain('docker compose stop');
  });

  it('starts the container when the pinned image is present but unhealthy', () => {
    stage = makeStage({ current: NEW_IMAGE, health: 'unhealthy' });

    const result = deploy(['main']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('container is missing, stopped or unhealthy');
    expect(dockerCalls()).toContain('docker compose stop');
    expect(dockerCalls()).toContain('docker compose up -d --wait --wait-timeout 90');
    expect(envValue('CORTECHO_IMAGE')).toBe(NEW_IMAGE);
  });

  it('warns and refuses when the database has a migration the image does not know', () => {
    stage = makeStage();
    const db = new DatabaseSync(join(stage.dir, 'data', 'app.db'));
    db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run(
      'extra-migration',
      999,
    );
    db.close();

    const result = deploy(['main']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('the database has migrations this image does not know');
    expect(result.output).toContain('rollback --restore-db');
    expect(result.output).toContain('refusing without a TTY');
    expect(envValue('CORTECHO_IMAGE')).toBe(OLD_IMAGE);
    expect(dockerCalls()).not.toContain('docker compose stop');
  });

  it('continues past the migration warning with --yes', () => {
    stage = makeStage();
    const db = new DatabaseSync(join(stage.dir, 'data', 'app.db'));
    db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run(
      'extra-migration',
      999,
    );
    db.close();

    const result = deploy(['main', '--yes']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('continuing because --yes was passed');
    expect(envValue('CORTECHO_IMAGE')).toBe(NEW_IMAGE);
  });

  it('refuses a fork PR before touching the stage', () => {
    stage = makeStage({ crossRepository: true });

    const result = deploy(['pr', '12']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('fork');
    expect(dockerCalls()).toBe('');
  });

  it('refuses a PR whose head owner is not the repository owner', () => {
    stage = makeStage({ headOwner: 'someone-else' });

    const result = deploy(['pr', '12']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('PR head owner is someone-else');
    expect(dockerCalls()).toBe('');
  });

  it('warns when the PR image revision is older than the PR head', () => {
    stage = makeStage({ imageRevision: 'oldsha', prHeadOid: 'deadbeef' });

    const result = deploy(['pr', '12']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('the PR image is older than the PR head; wait for the image job');
  });

  it('rolls back the image and the database when the new container is unhealthy', () => {
    stage = makeStage({ failUpOnce: true, previous: PRIOR_IMAGE });

    const result = deploy(['pr', '12']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('rolled back');
    expect(envValue('CORTECHO_IMAGE')).toBe(OLD_IMAGE);
    expect(envValue('PREVIOUS_IMAGE')).toBe(PRIOR_IMAGE);
    expect(readFileSync(join(stage.dir, 'data', 'app.db'))).toEqual(stage.originalDb);
    expect(backupDirectories()).toHaveLength(1);

    const calls = dockerCalls();
    expect(calls).toContain('docker compose stop');
    expect(calls.match(/docker compose up -d --wait --wait-timeout 90/g)?.length).toBe(2);
  });

  it('does not start the container when the rollback database restore fails', () => {
    const backup = '20240101T000000Z-222222222222';
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE, backups: [backup] });
    rmSync(join(stage.dir, 'backups', backup, 'app.db'));
    mkdirSync(join(stage.dir, 'backups', backup, 'app.db'));

    const result = deploy(['rollback', '--restore-db', '--yes']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('stage needs a human; backup is at');
    expect(result.output).toContain(`previous image ${OLD_IMAGE}`);
    expect(dockerCalls()).not.toContain('docker compose up -d --wait');
    expect(envValue('CORTECHO_IMAGE')).toBe(NEW_IMAGE);
  });

  it('swaps current and previous image on rollback', () => {
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE });

    const result = deploy(['rollback']);
    expect(result.status, result.output).toBe(0);
    expect(envValue('CORTECHO_IMAGE')).toBe(OLD_IMAGE);
    expect(envValue('PREVIOUS_IMAGE')).toBe(NEW_IMAGE);
    expect(dockerCalls()).toContain('docker compose up -d --wait --wait-timeout 90');
  });

  it('restores the newest backup with rollback --restore-db --yes, after a pre-rollback copy', () => {
    const backup = '20240101T000000Z-222222222222';
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE, backups: [backup] });
    writeFileSync(join(stage.dir, 'backups', backup, 'app.db'), 'backup database');
    writeFileSync(join(stage.dir, 'data', 'app.db'), 'current database');

    const result = deploy(['rollback', '--restore-db', '--yes']);
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(join(stage.dir, 'data', 'app.db'), 'utf8')).toBe('backup database');
    expect(result.output).toContain(`restore backup: ${backup} (age `);
    expect(result.output).toContain('backup suffix matches the image being left (222222222222): yes');
    const backups = readdirSync(join(stage.dir, 'backups'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(backups).toContain(backup);
    const preRollback = backups.find((name) => name.endsWith('-pre-rollback'));
    expect(preRollback).toBeDefined();
    expect(readFileSync(join(stage.dir, 'backups', preRollback ?? '', 'app.db'), 'utf8')).toBe(
      'current database',
    );
  });

  it('warns about migrations when rolling back without --restore-db', () => {
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE });
    const db = new DatabaseSync(join(stage.dir, 'data', 'app.db'));
    db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run(
      'extra-migration',
      999,
    );
    db.close();

    const result = deploy(['rollback']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`unknown to ${OLD_IMAGE}`);
    expect(result.output).toContain('rollback --restore-db');
  });

  it('explains the state and manual recovery when rollback does not become healthy', () => {
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE, failUpOnce: true });

    const result = deploy(['rollback']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('manual recovery');
    expect(result.output).toContain(`state: CORTECHO_IMAGE=${OLD_IMAGE}, PREVIOUS_IMAGE=${NEW_IMAGE}`);
    expect(envValue('CORTECHO_IMAGE')).toBe(OLD_IMAGE);
    expect(envValue('PREVIOUS_IMAGE')).toBe(NEW_IMAGE);
  });

  it('refuses --restore-db without --yes when there is no TTY', () => {
    const backup = '20240101T000000Z-111111111111';
    stage = makeStage({ current: NEW_IMAGE, previous: OLD_IMAGE, backups: [backup] });

    const result = deploy(['rollback', '--restore-db']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('refusing without a TTY');
    expect(envValue('CORTECHO_IMAGE')).toBe(NEW_IMAGE);
  });

  it('reports the running image, labels, health and newest backup', () => {
    stage = makeStage({ current: NEW_IMAGE, backups: ['20240101T000000Z-111111111111'] });

    const result = deploy(['status']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`CORTECHO_IMAGE=${NEW_IMAGE}`);
    expect(result.output).toContain('revision: deadbeef');
    expect(result.output).toContain('pr: 12');
    expect(result.output).toContain('tree: tree123');
    expect(result.output).toContain('health: healthy');
    expect(result.output).toContain('newest backup: 20240101T000000Z-111111111111');
  });

  it('warns from status when the running image has no HEALTHCHECK', () => {
    stage = makeStage({ current: NEW_IMAGE, health: 'none' });

    const result = deploy(['status']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('health: none');
    expect(result.output).toContain('the running image has no HEALTHCHECK');
  });

  it('writes through a symlinked .env and keeps the symlink', () => {
    stage = makeStage();
    const real = join(stage.dir, 'env.real');
    renameSync(join(stage.dir, '.env'), real);
    symlinkSync('env.real', join(stage.dir, '.env'));

    const result = deploy(['main']);
    expect(result.status, result.output).toBe(0);
    expect(lstatSync(join(stage.dir, '.env')).isSymbolicLink()).toBe(true);
    expect(readEnvValue(readFileSync(real, 'utf8'), 'CORTECHO_IMAGE')).toBe(NEW_IMAGE);
  });

  it('refuses a duplicate CORTECHO_IMAGE key before touching the stage', () => {
    stage = makeStage();
    writeFileSync(
      join(stage.dir, '.env'),
      `${readFileSync(join(stage.dir, '.env'), 'utf8')}CORTECHO_IMAGE=${OLD_IMAGE}\n`,
    );

    const result = deploy(['main']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('duplicate CORTECHO_IMAGE keys');
    expect(dockerCalls()).toBe('');
  });
});
