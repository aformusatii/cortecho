import { describe, expect, it } from 'vitest';
import { highestBump, nextVersion } from './next-version.mjs';

describe('nextVersion', () => {
  it('bumps a feat to the next minor', () => {
    expect(nextVersion('v0.3.0', [{ title: 'feat: add a history dialog' }])).toBe('0.4.0');
    expect(nextVersion('v1.2.3', [{ title: 'feat(web): add a page' }])).toBe('1.3.0');
  });

  it('bumps fix and perf to the next patch', () => {
    expect(nextVersion('v0.3.0', [{ title: 'fix: stop the flake' }])).toBe('0.3.1');
    expect(nextVersion('v1.2.3', [{ title: 'perf(api): fewer queries' }])).toBe('1.2.4');
  });

  it('bumps a breaking change to the next major after 1.0', () => {
    expect(nextVersion('v1.2.3', [{ title: 'feat!: drop the old API' }])).toBe('2.0.0');
    expect(nextVersion('v1.2.3', [{ title: 'refactor(core)!: rename everything' }])).toBe('2.0.0');
  });

  it('bumps a breaking change only to the next minor on 0.x', () => {
    expect(nextVersion('v0.3.0', [{ title: 'feat!: new protocol' }])).toBe('0.4.0');
    expect(
      nextVersion('v0.3.0', [{ title: 'fix: tidy', body: 'BREAKING CHANGE: the old field is gone' }]),
    ).toBe('0.4.0');
  });

  it('releases nothing for docs, test, ci, chore, refactor and build', () => {
    for (const type of ['docs', 'test', 'ci', 'chore', 'refactor', 'build']) {
      expect(nextVersion('v0.3.0', [{ title: `${type}: housekeeping` }])).toBeNull();
    }
  });

  it('releases a breaking change of a non-release type', () => {
    expect(nextVersion('v0.3.0', [{ title: 'chore!: drop Node 22' }])).toBe('0.4.0');
  });

  it('releases a BREAKING CHANGE footer even when the title is not breaking', () => {
    expect(nextVersion('v1.2.3', [{ title: 'chore: tidy', body: 'BREAKING CHANGE: nothing public' }])).toBe(
      '2.0.0',
    );
  });

  it('takes the highest bump over every commit since the last tag', () => {
    const commits = [
      { title: 'docs: readme' },
      { title: 'fix: a bug' },
      { title: 'feat: a feature' },
      { title: 'chore: tidy' },
    ];
    expect(nextVersion('v0.3.0', commits)).toBe('0.4.0');
    expect(nextVersion('v0.3.0', commits.slice(0, 2))).toBe('0.3.1');
    expect(
      nextVersion('v1.2.3', [
        ...commits,
        { title: 'refactor!: drop the old API', body: 'BREAKING CHANGE: yes' },
      ]),
    ).toBe('2.0.0');
  });

  it('returns null for an unparseable title and starts at 0.x without tags', () => {
    expect(nextVersion('v0.3.0', [{ title: 'Merge pull request #4' }])).toBeNull();
    expect(nextVersion(undefined, [{ title: 'feat: first release' }])).toBe('0.1.0');
    expect(nextVersion(null, [{ title: 'fix: first fix' }])).toBe('0.0.1');
  });
});

describe('highestBump', () => {
  it('is order-insensitive and accepts plain title strings', () => {
    expect(highestBump(['docs: x', 'fix: y'])).toBe('patch');
    expect(highestBump(['fix: y', 'feat: z'])).toBe('minor');
    expect(highestBump(['feat: z', 'chore!: breaking'])).toBe('major');
    expect(highestBump([])).toBe('none');
  });
});
