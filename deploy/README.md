# `cortecho-deploy`

Deploys a Cortecho image to a **stage** (a production-like folder serving real
Echoes) by pinning the image digest in the stage folder's `.env`. It does
configuration and backups only; it never builds or tests an image.

The script is generic. Everything machine-specific (paths, port, secret key,
Echo data) stays in the stage folder.

## Install

The stage folder holds a symlink to this launcher:

```bash
ln -s /path/to/cortecho/deploy/cortecho-deploy /path/to/stage/cortecho-deploy
```

Run it from anywhere:

```bash
/path/to/stage/cortecho-deploy status
```

The stage folder is resolved in this order:

1. `--dir <path>`
2. `CORTECHO_STAGE_DIR` in the environment
3. the directory the invoked symlink lives in
4. the current directory

The folder must contain `docker-compose.yml` and an `.env` with
`CORTECHO_IMAGE=`; otherwise the script refuses to run.

Requirements: Node.js 24 (runs the TypeScript directly), Docker with the
Compose plugin, and an authenticated `gh` for provenance verification.

## `.env` keys

| Key | Meaning |
|---|---|
| `CORTECHO_IMAGE` | **Required.** The image Compose runs; the script writes a digest-pinned value here |
| `PREVIOUS_IMAGE` | Managed by the script: the image replaced by the last deploy / rollback target |
| `STAGE_DIR`, `APP_PORT`, … | Read by the stage's `docker-compose.yml`; the script does not change them |

The script never prints the `.env` or `secrets.yaml`. It rewrites `.env`
atomically (fsync before rename, through a symlink if `.env` is one) by
replacing only the `CORTECHO_IMAGE=` and `PREVIOUS_IMAGE=` lines; every other
line and comment is preserved. Duplicate keys are refused before anything is
stopped.

Optional environment overrides (normally unnecessary):
`CORTECHO_IMAGE_REPO` (`ghcr.io/aformusatii/cortecho`) and
`CORTECHO_GITHUB_REPO` (`aformusatii/cortecho`).

## Commands

```bash
cortecho-deploy pr <N>                 # this PR's current image (:pr-N → digest)
cortecho-deploy main                   # :main (the normal way back after a merge)
cortecho-deploy version <X.Y.Z>        # a release
cortecho-deploy rollback               # PREVIOUS_IMAGE
cortecho-deploy rollback --restore-db  # …and the newest database backup
cortecho-deploy status                 # image, digest, labels, health, newest backup
```

Global options:

- `--dir <path>` — the stage folder
- `--dry-run` — print every step, change nothing
- `--yes` — confirm data loss / an older-image migration warning without a TTY
- `-h`, `--help`

## What a deploy does

1. Resolves the tag to the index digest by pulling it (`docker pull`) and
   reading the matching `repo@sha256:…` entry from
   `docker image inspect <ref> --format '{{json .RepoDigests}}'`, then verifies
   its build provenance with `gh attestation verify`. This does not need the
   buildx plugin. The pull happens before the stop, so registry failures cost
   no downtime. A `pr` deploy refuses a fork or a different head owner, warns
   when the required checks are not green, and warns when the image's revision
   label is older than the PR head.
2. Stops without changes only when that digest is running in a container that
   exists, is running and is healthy. Otherwise it starts the pinned image
   again.
3. Warns when the database has migrations the target image does not know (the
   image is older than work already applied), or when the live WAL database
   cannot be read. It names `rollback --restore-db`; continuing needs `--yes` or
   an interactive yes.
4. Stops the stage, copies exactly `app.db`, `app.db-wal`, `app.db-shm` and
   `app.db-journal` to `backups/<UTC yyyymmddTHHMMSSZ>-<old digest or tag>/`
   (copied as `.partial`, size-checked, then renamed), saves the old image as
   `PREVIOUS_IMAGE`, writes the new digest into `CORTECHO_IMAGE`, and runs
   `docker compose up -d --wait --wait-timeout 90`.
5. If the container is not healthy, restores the previous image and the backup
   just taken, starts again, and exits non-zero with the reason. A failed
   restore is never followed by a start: it prints `stage needs a human`.
6. Runs `cortecho doctor` as a **report** (its exit code is noted, never used to
   roll back), then keeps the newest five backup directories.

`rollback --restore-db` first takes a `backups/<stamp>-pre-rollback` copy, then
replaces the database from the newest backup, so data written after that
backup is lost. Without `--yes` it asks on a TTY and refuses otherwise.
Restores are staged under `data/.restore-tmp` and stale `-wal`/`-shm` files are
removed. A rollback without `--restore-db` reports how the previous image's
migrations compare with the current database.

## Interrupted deploy

If SIGINT/SIGTERM arrives between `docker compose stop` and a successful
`up --wait`, the script runs its recovery once (previous image, and the backup
taken for this deploy) and exits with code 130. If recovery cannot restore the
database or start the image, it does not start the container and prints:

```
stage needs a human; backup is at <backup dir>, previous image <image ref>
```

In that case inspect the state and recover manually:

1. Edit the stage `.env`: set `CORTECHO_IMAGE` to the image to run and
   `PREVIOUS_IMAGE` to the other one.
2. Restore the database: stop the stage, copy the files from the printed backup
   directory over the stage's `data/` directory (remove stale `app.db-wal` and
   `app.db-shm` first), and check that `data/app.db` is owned by the same user
   as `data/`.
3. Start it with `docker compose up -d --wait --wait-timeout 90` and run
   `cortecho-deploy status`.

A rollback whose `up --wait` fails prints the current `.env` values, the backup
it restored, and the exact manual steps; it never silently retries.

## What it never does

- Build or test an image (CI does that), or deploy a fork.
- Print secrets or the contents of `.env` / `secrets.yaml`.
- Run `docker image prune` or `docker rmi`; the running and previous images stay
  on the host for rollback.
- Delete the old flat `app.db.bak-*` files (only backup **directories** matching
  the timestamp pattern are pruned).
- Change the compose file, the database schema, or per-Echo settings.

Deployments are explicit: run it only when the owner asks. Keep one PR on stage
at a time and use forward-only, expand-then-contract migrations so
`cortecho-deploy main` can go back after an abandoned PR without restoring the
database.

## Tests

The unit tests run with `npm test`. The integration test drives this script
against a throwaway stage folder with fake `docker`/`gh` executables; it is
gated so normal test runs never need Docker or the network:

```bash
DEPLOY_INTEGRATION=1 npx vitest run --project deploy
```
