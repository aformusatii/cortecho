import { describe, expect, it } from 'vitest';
import {
  BACKUP_PATTERN,
  backupMatchesImage,
  backupName,
  backupNames,
  checkRollupVerdict,
  compareMigrations,
  countEnvKey,
  digestFromRef,
  digestFromRepoDigests,
  formatBackupAge,
  isDbFile,
  isDigest,
  newestBackup,
  parseArgs,
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
  utcStamp,
} from './lib.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('parseArgs', () => {
  it('parses every command', () => {
    expect(parseArgs(['pr', '12']).command).toEqual({ kind: 'pr', number: 12 });
    expect(parseArgs(['main']).command).toEqual({ kind: 'main' });
    expect(parseArgs(['version', '0.3.1']).command).toEqual({
      kind: 'version',
      version: '0.3.1',
    });
    expect(parseArgs(['rollback']).command).toEqual({ kind: 'rollback', restoreDb: false });
    expect(parseArgs(['rollback', '--restore-db']).command).toEqual({
      kind: 'rollback',
      restoreDb: true,
    });
    expect(parseArgs(['status']).command).toEqual({ kind: 'status' });
  });

  it('parses global options anywhere and --dir in both forms', () => {
    const parsed = parseArgs(['--dry-run', '--dir', '/stage', 'pr', '7', '--yes']);
    expect(parsed).toMatchObject({ dir: '/stage', dryRun: true, yes: true });
    expect(parseArgs(['main', '--dir=/stage']).dir).toBe('/stage');
  });

  it('prints help without requiring a command', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['pr', '1', '-h']).help).toBe(true);
  });

  it.each([
    [[], 'missing command'],
    [['pr'], 'pr needs one PR number'],
    [['pr', 'abc'], 'invalid PR number'],
    [['pr', '0'], 'invalid PR number'],
    [['pr', '1', '2'], 'pr needs one PR number'],
    [['main', 'extra'], 'main takes no arguments'],
    [['version', '1.2'], 'invalid version'],
    [['status', 'extra'], 'status takes no arguments'],
    [['main', '--restore-db'], 'only valid with rollback'],
    [['wat'], 'unknown command'],
    [['main', '--wat'], 'unknown option'],
    [['main', '--dir'], '--dir needs a value'],
    [['main', '--dir='], '--dir needs a value'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message as string);
  });
});

describe('targetRef', () => {
  it('maps each command to its tag', () => {
    const repo = 'ghcr.io/example/cortecho';
    expect(targetRef({ kind: 'pr', number: 12 }, repo)).toBe(`${repo}:pr-12`);
    expect(targetRef({ kind: 'main' }, repo)).toBe(`${repo}:main`);
    expect(targetRef({ kind: 'version', version: '1.2.3' }, repo)).toBe(`${repo}:1.2.3`);
    expect(targetRef({ kind: 'rollback', restoreDb: false }, repo)).toBeNull();
    expect(targetRef({ kind: 'status' }, repo)).toBeNull();
  });
});

describe('stageDirFrom', () => {
  it('prefers --dir, then the environment, then the invoked symlink, then cwd', () => {
    const cwd = '/repo/checkout';
    expect(stageDirFrom({ dir: '/stage', cwd })).toBe('/stage');
    expect(stageDirFrom({ envDir: 'env-stage', cwd })).toBe('/repo/checkout/env-stage');
    expect(stageDirFrom({ invokedAs: '/home/x/apps/cortecho/cortecho-deploy', cwd })).toBe(
      '/home/x/apps/cortecho',
    );
    expect(stageDirFrom({ invokedAs: './cortecho-deploy', cwd })).toBe(cwd);
    expect(stageDirFrom({ cwd })).toBe(cwd);
    expect(stageDirFrom({ envDir: '', cwd })).toBe(cwd);
  });

  it('does not follow the final symlink of the invoked path', () => {
    expect(stageDirFrom({ invokedAs: '/stage/cortecho-deploy', cwd: '/' })).toBe('/stage');
  });
});

describe('.env helpers', () => {
  const env = [
    '# stage settings',
    'STAGE_DIR=/home/x/apps/cortecho',
    'APP_PORT=8063',
    'CORTECHO_IMAGE=cortecho:dev',
    '',
    'export PREVIOUS_IMAGE=old # keep this note',
    '',
  ].join('\n');

  it('reads plain, exported and quoted values', () => {
    expect(readEnvValue(env, 'STAGE_DIR')).toBe('/home/x/apps/cortecho');
    expect(readEnvValue(env, 'PREVIOUS_IMAGE')).toBe('old');
    expect(readEnvValue(env, 'MISSING')).toBeNull();
    expect(readEnvValue('A="hello world"\nB=\'x\'\n', 'A')).toBe('hello world');
    expect(readEnvValue("B='x'\n", 'B')).toBe('x');
    expect(readEnvValue('C=value # with a comment\n', 'C')).toBe('value');
    expect(readEnvValue('D="value # kept"\n', 'D')).toBe('value # kept');
  });

  it('replaces one line and keeps every other line and comment', () => {
    const next = setEnvValue(env, 'CORTECHO_IMAGE', `ghcr.io/x/cortecho@${DIGEST}`);
    expect(next).toContain('# stage settings');
    expect(next).toContain('STAGE_DIR=/home/x/apps/cortecho');
    expect(next).toContain('APP_PORT=8063');
    expect(next).toContain(`CORTECHO_IMAGE=ghcr.io/x/cortecho@${DIGEST}`);
    expect(next).toContain('export PREVIOUS_IMAGE=old # keep this note');
    expect(next.endsWith('\n')).toBe(true);
    expect(next.split('\n').filter((line) => line.startsWith('CORTECHO_IMAGE='))).toHaveLength(1);
  });

  it('keeps an inline comment on the replaced line', () => {
    const next = setEnvValue('CORTECHO_IMAGE=old # current\n', 'CORTECHO_IMAGE', 'new');
    expect(next).toBe('CORTECHO_IMAGE=new # current\n');
  });

  it('appends a missing key and preserves a missing final newline', () => {
    expect(setEnvValue('A=1', 'B', '2')).toBe('A=1\nB=2');
    expect(setEnvValue('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
    expect(setEnvValue('A=1\r\n', 'A', '2')).toBe('A=2\r\n');
  });

  it('counts keys and refuses duplicates', () => {
    expect(countEnvKey(env, 'CORTECHO_IMAGE')).toBe(1);
    expect(countEnvKey('CORTECHO_IMAGE=a\n# CORTECHO_IMAGE=b\n', 'CORTECHO_IMAGE')).toBe(1);
    expect(() => setEnvValue('CORTECHO_IMAGE=a\nCORTECHO_IMAGE=b\n', 'CORTECHO_IMAGE', 'c')).toThrow(
      'duplicate CORTECHO_IMAGE keys',
    );
    expect(() =>
      setEnvValue('A=1\nPREVIOUS_IMAGE=x\nexport PREVIOUS_IMAGE=y\n', 'PREVIOUS_IMAGE', 'z'),
    ).toThrow('duplicate PREVIOUS_IMAGE keys');
  });
});

describe('image references and backups', () => {
  it('reads and shortens digests', () => {
    expect(digestFromRef(`ghcr.io/x/cortecho@${DIGEST}`)).toBe(DIGEST);
    expect(digestFromRef('ghcr.io/x/cortecho:main')).toBeNull();
    expect(isDigest(DIGEST)).toBe(true);
    expect(isDigest('sha256:abc')).toBe(false);
    expect(shortDigest(DIGEST)).toBe('a'.repeat(12));
  });

  it('names a backup with a sortable UTC stamp and the old digest or tag', () => {
    expect(utcStamp(new Date('2026-11-28T07:08:09Z'))).toBe('20261128T070809Z');
    expect(backupName(new Date('2026-11-28T07:08:09Z'), `repo@${DIGEST}`)).toBe(
      `20261128T070809Z-${'a'.repeat(12)}`,
    );
    expect(backupName(new Date('2026-11-28T07:08:09Z'), 'cortecho:dev')).toBe(
      '20261128T070809Z-cortecho-dev',
    );
  });

  it('keeps the newest five backups and ignores flat files and other names', () => {
    const names = [
      '20240101T000000Z-old1',
      'app.db.bak-2024',
      '20240102T000000Z-old2',
      '20240103T000000Z-old3',
      '20240104T000000Z-old4',
      '20240105T000000Z-old5',
      '20240106T000000Z-old6',
      '20240107T000000Z-old7',
      'notes',
    ];
    expect(backupNames(names)[0]).toBe('20240107T000000Z-old7');
    expect(newestBackup(names)).toBe('20240107T000000Z-old7');
    expect(selectBackupsToPrune(names)).toEqual(['20240102T000000Z-old2', '20240101T000000Z-old1']);
    expect(selectBackupsToPrune(names, 10)).toEqual([]);
  });

  it('never treats a partial backup as a backup', () => {
    expect(BACKUP_PATTERN.test('20240101T000000Z-abc')).toBe(true);
    expect(BACKUP_PATTERN.test('20240101T000000Z-abc.partial')).toBe(false);
    expect(backupNames(['20240101T000000Z-abc.partial', '20240101T000000Z-abc'])).toEqual([
      '20240101T000000Z-abc',
    ]);
  });

  it('recognises only the four database files', () => {
    expect(isDbFile('app.db')).toBe(true);
    expect(isDbFile('app.db-wal')).toBe(true);
    expect(isDbFile('app.db-shm')).toBe(true);
    expect(isDbFile('app.db-journal')).toBe(true);
    expect(isDbFile('app.db.bak-20240101')).toBe(false);
    expect(isDbFile('app.db-wal-old')).toBe(false);
  });

  it('describes a backup age and whether its suffix matches the image being left', () => {
    expect(formatBackupAge('20240101T000000Z-abc', new Date('2024-01-02T03:04:05Z'))).toBe('1d 3h 4m');
    expect(backupMatchesImage(`20240101T000000Z-${'a'.repeat(12)}`, `repo@${DIGEST}`)).toBe(true);
    expect(backupMatchesImage(`20240101T000000Z-${'b'.repeat(12)}`, `repo@${DIGEST}`)).toBe(false);
  });
});

describe('digest parsing', () => {
  it('splits a tag reference from its repository', () => {
    expect(repoOfTagRef('ghcr.io/aformusatii/cortecho:pr-6')).toBe('ghcr.io/aformusatii/cortecho');
    expect(repoOfTagRef('localhost:5000/team/cortecho:1.2.3')).toBe('localhost:5000/team/cortecho');
    expect(repoOfTagRef('cortecho:dev')).toBe('cortecho');
    expect(repoOfTagRef('cortecho')).toBeNull();
  });

  it('takes the repository entry from RepoDigests (the index digest)', () => {
    const output = JSON.stringify([
      'other.example/cortecho@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      `ghcr.io/x/cortecho@${DIGEST}`,
    ]);
    expect(digestFromRepoDigests(output, 'ghcr.io/x/cortecho')).toBe(DIGEST);
    expect(digestFromRepoDigests(output, 'ghcr.io/y/cortecho')).toBeNull();
    expect(digestFromRepoDigests('not json', 'ghcr.io/x/cortecho')).toBeNull();
    expect(digestFromRepoDigests(JSON.stringify([]), 'ghcr.io/x/cortecho')).toBeNull();
  });
});

describe('migrations', () => {
  it('flags database rows the image journal does not know', () => {
    const journal = [
      { when: 1000, tag: '0000_a', idx: 0 },
      { when: 2000, tag: '0001_b', idx: 1 },
    ];
    const applied = [
      { id: 1, hash: 'h1', createdAt: 1000 },
      { id: 2, hash: 'h2', createdAt: 2000 },
      { id: 3, hash: 'h3', createdAt: 3000 },
    ];
    expect(compareMigrations(journal, applied)).toEqual({
      unknown: [{ id: 3, hash: 'h3', createdAt: 3000 }],
      knownCount: 2,
    });
    expect(compareMigrations(journal, applied.slice(0, 2)).unknown).toEqual([]);
  });
});

describe('pull request checks', () => {
  it('accepts only a same-repository PR from the repository owner', () => {
    expect(
      prGuardVerdict(
        { isCrossRepository: false, headRepositoryOwner: { login: 'aformusatii' } },
        'aformusatii',
      ),
    ).toEqual({ ok: true, reason: null });
    expect(
      prGuardVerdict(
        { isCrossRepository: true, headRepositoryOwner: { login: 'aformusatii' } },
        'aformusatii',
      ).ok,
    ).toBe(false);
    expect(
      prGuardVerdict(
        { isCrossRepository: null, headRepositoryOwner: { login: 'aformusatii' } },
        'aformusatii',
      ).ok,
    ).toBe(false);
    expect(
      prGuardVerdict({ isCrossRepository: false, headRepositoryOwner: { login: 'someone' } }, 'aformusatii')
        .ok,
    ).toBe(false);
    expect(prGuardVerdict({ isCrossRepository: false }, 'aformusatii').ok).toBe(false);
  });

  it('compares the PR head with the image revision label', () => {
    expect(revisionMismatch('deadbeef', 'deadbeef')).toBe(false);
    expect(revisionMismatch('deadbeef', 'oldsha')).toBe(true);
    expect(revisionMismatch(null, 'oldsha')).toBe(false);
    expect(revisionMismatch('deadbeef', null)).toBe(false);
  });

  it('accepts green check runs and status contexts', () => {
    const checks = parseRollup([
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'image', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { context: 'integration', state: 'SUCCESS' },
      { name: 'pr-title', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'other', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]);
    expect(checkRollupVerdict(checks)).toEqual({ ok: true, failed: [], missing: [] });
  });

  it('reports failing, pending and missing required checks', () => {
    const checks = parseRollup([
      { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'image', status: 'IN_PROGRESS', conclusion: null },
      { context: 'integration', state: 'PENDING' },
    ]);
    expect(checkRollupVerdict(checks)).toEqual({
      ok: false,
      failed: ['ci (failure)', 'image (in_progress)', 'integration (pending)'],
      missing: ['pr-title'],
    });
  });

  it('tolerates a missing rollup', () => {
    expect(parseRollup(null)).toEqual([]);
    expect(checkRollupVerdict([], ['ci'])).toEqual({
      ok: false,
      failed: [],
      missing: ['ci'],
    });
  });
});
