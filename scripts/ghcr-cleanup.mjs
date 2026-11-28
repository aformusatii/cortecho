import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Keeps ghcr small without breaking an image that is still in use. Deletes
 * only versions that are older than the cutoff and are either PR-push tagged
 * (pr-<N>, sha-<hex>, tree-<hex>), untagged, or an attestation referrer (a
 * `sha256-<hex>` tag, or a manifest whose `subject` points at another image)
 * whose subject is also gone.
 *
 * Never deleted:
 * - a version with a protected tag (main, latest, X.Y, X.Y.Z, anything else)
 * - a version tagged `pr-<N>` for an OPEN pull request (however old)
 * - a child of such an index (a multi-arch image, and the provenance/SBOM
 *   manifests buildx stores in it)
 * - an attestation referrer whose `subject` digest is protected
 *
 * Fail closed: if any manifest cannot be read, nothing is deleted.
 * Scheduled runs are dry until the owner sets the repository variable
 * GHCR_CLEANUP_ENABLED=true (see .github/workflows/ghcr-cleanup.yml).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tags the pipeline creates for one PR push; anything else is protected. */
const EPHEMERAL_TAG = /^(pr-|sha-|tree-)/;
/** A referrers-fallback tag: `sha256-<64 hex>`; its subject is that digest. */
const REFERRER_TAG = /^sha256-[0-9a-f]{64}$/;

/**
 * @param {Array<{ id: number, name: string, created_at: string, metadata?: { container?: { tags?: string[] } } }>} versions
 * @param {{
 *   now?: number,
 *   cutoffDays?: number,
 *   protectedDigests?: Set<string>,
 *   subjects?: Map<string, string | null>,
 *   openPrs?: Set<number>,
 * }} [options]
 */
export function decideVersions(versions, options = {}) {
  const now = options.now ?? Date.now();
  const cutoffDays = options.cutoffDays ?? 3;
  const protectedDigests = options.protectedDigests ?? new Set();
  const subjects = options.subjects ?? new Map();
  const openPrs = options.openPrs ?? new Set();
  return versions.map((version) => {
    const tags = tagsOf(version);
    const createdAt = Date.parse(version.created_at);
    const ageDays = Number.isFinite(createdAt) ? (now - createdAt) / DAY_MS : Number.NaN;
    const base = { version, tags, ageDays };

    const openPr = openPrNumber(version, openPrs);
    if (openPr !== null) {
      return { ...base, action: 'keep', reason: `tag of open PR #${openPr}` };
    }
    if (!isEphemeral(version)) {
      return { ...base, action: 'keep', reason: 'carries a protected tag' };
    }
    if (protectedDigests.has(version.name)) {
      return { ...base, action: 'keep', reason: 'child or referrer of a protected/young/open-PR image' };
    }
    const subject = subjects.get(version.name);
    if (subject && protectedDigests.has(subject)) {
      return { ...base, action: 'keep', reason: `attestation referrer of protected ${subject}` };
    }
    if (!Number.isFinite(createdAt) || now - createdAt < cutoffDays * DAY_MS) {
      return { ...base, action: 'keep', reason: 'younger than the cutoff' };
    }
    return {
      ...base,
      action: 'delete',
      reason: deleteReason(version),
    };
  });
}

/** True when every tag is a PR-push tag or a referrers-fallback tag (or none). */
export function isEphemeral(version) {
  const tags = tagsOf(version);
  return tags.length === 0 || tags.every((tag) => EPHEMERAL_TAG.test(tag) || REFERRER_TAG.test(tag));
}

export function tagsOf(version) {
  return version.metadata?.container?.tags ?? [];
}

/** The open PR number whose `pr-<N>` tag this version carries, or null. */
export function openPrNumber(version, openPrs) {
  for (const tag of tagsOf(version)) {
    const match = /^pr-(\d+)$/.exec(tag);
    if (match && openPrs.has(Number(match[1]))) return Number(match[1]);
  }
  return null;
}

/**
 * The subject an attestation referrer points at, from its referrers-fallback
 * tag when the manifest itself does not carry a `subject` field.
 */
export function subjectFromTag(version) {
  for (const tag of tagsOf(version)) {
    if (REFERRER_TAG.test(tag)) return `sha256:${tag.slice('sha256-'.length)}`;
  }
  return null;
}

/** The versions whose own digest and descendants must never be deleted. */
export function indexRoots(versions, { now = Date.now(), cutoffDays = 3, openPrs = new Set() } = {}) {
  const cutoff = now - cutoffDays * DAY_MS;
  return versions.filter((version) => {
    const created = Date.parse(version.created_at);
    // A protected tag, an open PR, or a young version (its children may still
    // be used while it ages past the cutoff).
    return (
      !isEphemeral(version) ||
      openPrNumber(version, openPrs) !== null ||
      !Number.isFinite(created) ||
      created > cutoff
    );
  });
}

/**
 * Every digest that must survive: the roots, their children recursively, and
 * attestation referrers whose `subject` is one of those (also recursively, so
 * an attestation of an attestation is covered).
 *
 * @param {Array<{ id: number, name: string, created_at: string }>} versions
 * @param {Array<{ name: string }>} roots
 * @param {Map<string, { children: string[], subject: string | null }>} info
 */
export function collectProtectedDigests(versions, roots, info) {
  const protectedDigests = new Set();
  const visit = (digest) => {
    if (!digest || protectedDigests.has(digest)) return;
    protectedDigests.add(digest);
    for (const child of info.get(digest)?.children ?? []) visit(child);
  };
  for (const root of roots) visit(root.name);

  // Referrers (sha256-<hex> tags or untagged attestations) point at a subject
  // instead of being a child; protect them while their subject is protected.
  let changed = true;
  while (changed) {
    changed = false;
    for (const version of versions) {
      if (protectedDigests.has(version.name)) continue;
      const subject = info.get(version.name)?.subject;
      if (subject && protectedDigests.has(subject)) {
        visit(version.name);
        changed = true;
      }
    }
  }
  return protectedDigests;
}

/** Reads a manifest once: its index children and its attestation subject. */
export function inspectManifest(image, digest, run = execFileSync) {
  const raw = run('docker', ['buildx', 'imagetools', 'inspect', `${image}@${digest}`, '--raw'], {
    encoding: 'utf8',
  });
  const manifest = JSON.parse(raw);
  return {
    children: Array.isArray(manifest.manifests)
      ? manifest.manifests.map((entry) => entry.digest).filter((value) => typeof value === 'string')
      : [],
    subject: typeof manifest.subject?.digest === 'string' ? manifest.subject.digest : null,
  };
}

function deleteReason(version) {
  const tags = tagsOf(version);
  if (tags.length === 0) return 'untagged and older than the cutoff';
  if (tags.every((tag) => REFERRER_TAG.test(tag))) {
    return 'attestation referrer, older than the cutoff, subject is not protected';
  }
  return 'only pr/sha/tree tags and older than the cutoff';
}

function listVersions(account, accountType, pkg) {
  const base = accountType === 'org' ? 'orgs' : 'users';
  const pages = JSON.parse(
    execFileSync(
      'gh',
      ['api', '--paginate', '--slurp', `${base}/${account}/packages/container/${pkg}/versions?per_page=100`],
      { encoding: 'utf8' },
    ),
  );
  return pages.flat();
}

function deleteVersion(account, accountType, pkg, id) {
  const base = accountType === 'org' ? 'orgs' : 'users';
  execFileSync('gh', [
    'api',
    '--method',
    'DELETE',
    `${base}/${account}/packages/container/${pkg}/versions/${id}`,
  ]);
}

function main() {
  const account = process.env.ACCOUNT ?? process.env.GITHUB_REPOSITORY_OWNER ?? '';
  const accountType = process.env.ACCOUNT_TYPE === 'org' ? 'org' : 'user';
  const pkg = process.env.PACKAGE ?? '';
  const image = process.env.IMAGE ?? '';
  const dryRun = process.env.DRY_RUN !== 'false';
  const cutoffDays = Number(process.env.CUTOFF_DAYS ?? '3');
  if (!account || !pkg || !image) {
    console.error('cleanup: ACCOUNT, PACKAGE and IMAGE are required');
    process.exit(2);
  }
  let openPrs = new Set();
  try {
    openPrs = new Set(JSON.parse(process.env.OPEN_PRS ?? '[]').map(Number));
  } catch {
    console.error('cleanup: OPEN_PRS must be a JSON array of PR numbers');
    process.exit(2);
  }

  const versions = listVersions(account, accountType, pkg);
  console.log(
    `${dryRun ? 'DRY RUN' : 'REAL RUN'}: ${versions.length} version(s) in ${image}, cutoff ${cutoffDays} days, ${openPrs.size} open PR(s)`,
  );

  // Read every manifest first: a registry error must abort the run before
  // anything is deleted. The same read gives the index children and the
  // attestation subject of every version; a referrers-fallback tag names the
  // subject even when the manifest does not.
  const info = new Map();
  for (const version of versions) {
    const entry = inspectManifest(image, version.name);
    entry.subject ??= subjectFromTag(version);
    info.set(version.name, entry);
  }

  const roots = indexRoots(versions, { cutoffDays, openPrs });
  const protectedDigests = collectProtectedDigests(versions, roots, info);
  const subjects = new Map([...info].map(([digest, entry]) => [digest, entry.subject]));
  const decisions = decideVersions(versions, { cutoffDays, protectedDigests, subjects, openPrs });

  for (const row of decisions) {
    const tags = row.tags.length > 0 ? row.tags.join(', ') : '(untagged)';
    const age = Number.isFinite(row.ageDays) ? `${row.ageDays.toFixed(1)}d` : 'unknown age';
    console.log(
      `  ${row.action.padEnd(6)} id=${row.version.id} ${row.version.name} [${tags}] ${age}: ${row.reason}`,
    );
  }

  const deletable = decisions.filter((row) => row.action === 'delete');
  console.log(`${deletable.length} version(s) would be deleted; ${decisions.length - deletable.length} kept`);
  if (dryRun || deletable.length === 0) return;

  for (const row of deletable) {
    try {
      deleteVersion(account, accountType, pkg, row.version.id);
      console.log(`deleted id=${row.version.id} ${row.version.name}`);
    } catch (error) {
      console.error(`failed to delete id=${row.version.id}: ${String(error)}`);
      process.exitCode = 1;
    }
  }
}

// Only run the CLI when executed, so the tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
