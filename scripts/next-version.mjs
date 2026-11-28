import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Semantic version from the squashed Conventional Commits on main. The git tag
 * is the source of truth: this never writes a version anywhere except the
 * workflow's tag and image tags. Plain Node ESM, no dependencies, because the
 * release workflow runs it with `node scripts/next-version.mjs`.
 *
 * GitHub keeps only one pending run per concurrency group, so a merge can cause
 * the run of an earlier merge to be dropped. Computing the bump over EVERY
 * commit since the last tag (not only HEAD) means the surviving run still
 * releases the highest bump those merges imply.
 */

/**
 * @param {string | null | undefined} latestTag highest `v*` tag, e.g. `v0.3.0`
 * @param {Array<string | { title?: string, body?: string }>} commits the
 *   squash commits since that tag, newest or oldest order (order does not
 *   matter: the highest bump wins)
 * @returns {string | null} `X.Y.Z`, or null when none of them publishes
 */
export function nextVersion(latestTag, commits = []) {
  const base = parseTag(latestTag) ?? { major: 0, minor: 0, patch: 0 };
  const bump = highestBump(commits);
  if (bump === 'none') return null;
  // While the project is 0.x, SemVer's 0.x convention bumps the minor instead
  // of the major, also for a breaking change (owner decision D3).
  if (bump === 'major') {
    return base.major === 0 ? `${base.major}.${base.minor + 1}.0` : `${base.major + 1}.0.0`;
  }
  if (bump === 'minor') return `${base.major}.${base.minor + 1}.0`;
  return `${base.major}.${base.minor}.${base.patch + 1}`;
}

/** The strongest bump any one commit asks for: major > minor > patch > none. */
export function highestBump(commits) {
  let bump = 'none';
  for (const commit of Array.isArray(commits) ? commits : [commits]) {
    if (commit === null || commit === undefined) continue;
    const title = typeof commit === 'string' ? commit : (commit.title ?? '');
    const body = typeof commit === 'string' ? '' : (commit.body ?? '');
    // type(scope)!: subject. `!` is the only way a PR title can mark a breaking
    // change (a title is one line); the body can also carry the footer.
    const header = /^([a-z]+)(?:\([^)]*\))?(!)?:\s+\S/.exec(title.trim());
    if (!header) continue;
    if (header[2] === '!' || /(^|\n)BREAKING CHANGE:/.test(body)) return 'major';
    if (header[1] === 'feat') bump = bump === 'major' ? 'major' : 'minor';
    else if ((header[1] === 'fix' || header[1] === 'perf') && bump === 'none') bump = 'patch';
  }
  return bump;
}

function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec((tag ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Only run the CLI when executed, so the test can import the pure function.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = option('--commits-file');
  const commits = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : [{ title: option('--title') ?? '', body: option('--body') ?? '' }];
  const version = nextVersion(option('--latest'), commits);
  if (version !== null) process.stdout.write(`${version}\n`);
}
