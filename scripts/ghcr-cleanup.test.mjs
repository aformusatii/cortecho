import { describe, expect, it } from 'vitest';
import {
  collectProtectedDigests,
  decideVersions,
  indexRoots,
  inspectManifest,
  isEphemeral,
  subjectFromTag,
} from './ghcr-cleanup.mjs';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const sha = (n) => `sha256:${String(n).padStart(64, '0')}`;
const referrerTag = (n) => sha(n).replace(':', '-');
const version = (id, tags, ageDays, name = sha(id)) => ({
  id,
  name,
  created_at: new Date(NOW - ageDays * day).toISOString(),
  metadata: { container: { tags } },
});
const info = (entries) => new Map(Object.entries(entries));

describe('decideVersions', () => {
  it('deletes a PR-push version older than the cutoff', () => {
    const [row] = decideVersions([version(1, ['pr-7', 'sha-abc', 'tree-def'], 4)], { now: NOW });
    expect(row.action).toBe('delete');
  });

  it('keeps a young PR-push version', () => {
    const [row] = decideVersions([version(1, ['pr-7'], 1)], { now: NOW });
    expect(row.action).toBe('keep');
    expect(row.reason).toMatch(/cutoff/);
  });

  it.each(['main', 'latest', '0.3', '0.3.0'])('never deletes a version tagged %s', (tag) => {
    const [row] = decideVersions([version(1, [tag, 'sha-abc'], 30)], { now: NOW });
    expect(row.action).toBe('keep');
    expect(row.reason).toMatch(/protected/);
  });

  it('never deletes the image of an open PR, however old', () => {
    const [row] = decideVersions([version(1, ['pr-12', 'sha-abc', 'tree-def'], 90)], {
      now: NOW,
      openPrs: new Set([12]),
    });
    expect(row.action).toBe('keep');
    expect(row.reason).toBe('tag of open PR #12');
  });

  it('deletes an old PR image once its PR is closed', () => {
    const [row] = decideVersions([version(1, ['pr-12', 'sha-abc'], 90)], { now: NOW });
    expect(row.action).toBe('delete');
  });

  it('keeps a protected child even when it is old and untagged', () => {
    const [row] = decideVersions([version(2, [], 10)], {
      now: NOW,
      protectedDigests: new Set([sha(2)]),
    });
    expect(row.action).toBe('keep');
    expect(row.reason).toMatch(/child/);
  });

  it('deletes an old untagged version that is not a child of a protected image', () => {
    const [row] = decideVersions([version(2, [], 10)], { now: NOW });
    expect(row.action).toBe('delete');
  });

  it('keeps a version whose age cannot be read', () => {
    const [row] = decideVersions(
      [{ id: 3, name: sha(3), created_at: 'not a date', metadata: { container: { tags: [] } } }],
      { now: NOW },
    );
    expect(row.action).toBe('keep');
  });

  it('keeps a sha256-<hex> attestation referrer whose subject is protected', () => {
    const [row] = decideVersions([version(5, [referrerTag(4)], 30)], {
      now: NOW,
      protectedDigests: new Set([sha(4)]),
      subjects: new Map([[sha(5), sha(4)]]),
    });
    expect(row.action).toBe('keep');
    expect(row.reason).toMatch(/attestation referrer/);
  });

  it('deletes an old sha256-<hex> referrer when its subject is not protected', () => {
    const [row] = decideVersions([version(5, [referrerTag(4)], 30)], {
      now: NOW,
      subjects: new Map([[sha(5), sha(4)]]),
    });
    expect(row.action).toBe('delete');
    expect(row.reason).toBe('attestation referrer, older than the cutoff, subject is not protected');
  });

  it('keeps an untagged manifest whose subject.digest is protected', () => {
    const [row] = decideVersions([version(6, [], 30)], {
      now: NOW,
      protectedDigests: new Set([sha(4)]),
      subjects: new Map([[sha(6), sha(4)]]),
    });
    expect(row.action).toBe('keep');
  });
});

describe('isEphemeral / indexRoots / collectProtectedDigests', () => {
  it('recognises PR-push tags and referrers-fallback tags', () => {
    expect(isEphemeral({ metadata: { container: { tags: ['pr-1', 'sha-x', 'tree-y'] } } })).toBe(true);
    expect(isEphemeral({ metadata: { container: { tags: [referrerTag(1)] } } })).toBe(true);
    expect(isEphemeral({ metadata: { container: { tags: ['pr-1', 'main'] } } })).toBe(false);
    expect(isEphemeral({ metadata: { container: { tags: [] } } })).toBe(true);
  });

  it('derives the subject from a referrers-fallback tag', () => {
    expect(subjectFromTag({ metadata: { container: { tags: [referrerTag(7)] } } })).toBe(sha(7));
    expect(subjectFromTag({ metadata: { container: { tags: ['pr-7', 'sha-x'] } } })).toBeNull();
  });

  it('protects the children of young, protected and open-PR versions only', () => {
    const roots = indexRoots(
      [version(1, ['main'], 40), version(2, ['pr-2'], 1), version(3, ['pr-3'], 9), version(4, ['pr-12'], 90)],
      { now: NOW, openPrs: new Set([12]) },
    );
    expect(roots.map((entry) => entry.id)).toEqual([1, 2, 4]);
  });

  it('walks index children recursively and protects referrers of protected images', () => {
    const versions = [
      { id: 1, name: sha(1), created_at: new Date(NOW).toISOString() },
      { id: 2, name: sha(2), created_at: new Date(NOW).toISOString() },
      { id: 3, name: sha(3), created_at: new Date(NOW).toISOString() },
      { id: 4, name: sha(4), created_at: new Date(NOW).toISOString() },
      { id: 5, name: sha(5), created_at: new Date(NOW).toISOString() },
    ];
    const manifests = info({
      [sha(1)]: { children: [sha(2), sha(3)], subject: null },
      [sha(2)]: { children: [], subject: null },
      [sha(3)]: { children: [], subject: null },
      [sha(4)]: { children: [], subject: sha(2) },
      [sha(5)]: { children: [], subject: sha(3) },
    });
    const protectedDigests = collectProtectedDigests(versions, [{ name: sha(1) }], manifests);
    expect([...protectedDigests].sort()).toEqual([sha(1), sha(2), sha(3), sha(4), sha(5)].sort());
  });

  it('reads children and the attestation subject from a manifest', () => {
    const run = (_cmd, args) => {
      const ref = args.at(-2);
      const digest = ref.slice(ref.indexOf('@') + 1);
      if (digest === sha(1)) return JSON.stringify({ manifests: [{ digest: sha(2) }] });
      return JSON.stringify({ subject: { digest: sha(1) } });
    };
    expect(inspectManifest('ghcr.io/x/y', sha(1), run)).toEqual({ children: [sha(2)], subject: null });
    expect(inspectManifest('ghcr.io/x/y', sha(9), run)).toEqual({ children: [], subject: sha(1) });
  });
});
