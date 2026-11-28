# Deployment

Cortecho is one container: the API, the SPA and the SQLite database. Run it on
a machine on the same LAN as the Echo(s).

## Quick start (published image)

```bash
mkdir cortecho && cd cortecho
curl -O https://raw.githubusercontent.com/aformusatii/cortecho/main/docker-compose.yml
docker compose up -d
```

Then open `http://<docker-host>:3000` and follow **Setup**: it finds the Echo,
secures the link and adds it, and the reply address, the time zone and the
OpenAI key are set in the UI.

The environment file is **optional**; the compose file as downloaded works
(the compose file marks it `required: false`). Copy
[`cortecho.env.example`](https://raw.githubusercontent.com/aformusatii/cortecho/main/cortecho.env.example)
to `cortecho.env` next to the compose file only for what cannot be a setting:
`TZ` (also the container clock), an OpenAI-compatible `OPENAI_BASE_URL`,
connectors (`CORTECHO_SECRET_KEY`, `PUBLIC_BASE_URL`) and tools. Nothing there
is imported into an existing database, so after the first start change
behaviour in the UI. `docker compose exec app cortecho doctor` prints the fix
for anything still wrong.

The published image is `ghcr.io/aformusatii/cortecho`. `:latest` follows the
newest **release** (not the newest `main` commit); pin a version or digest in
production (below). Building from source is for development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Image tags

| Tag | Moves | Use |
|---|---|---|
| `:latest` | Each release | The newest release; convenient, not pinned |
| `:X.Y.Z` | Never | One release; the recommended production pin |
| `:X.Y` | Each patch | The newest patch in that minor line |
| `:main` | Each merge | Newest merged code, possibly unreleased |
| `:pr-N`, `:sha-<commit>`, `:tree-<hash>` | Each same-repo PR push | The image CI tested; deleted after 3 days (kept while the PR is open). Fork PRs build locally and are not pushed |

A release never rebuilds: it adds `:X.Y.Z`, `:X.Y` and `:latest` to the digest
that the PR's `image` job built, the `integration` job tested and stage may
already have run.

## Pin an image

Pin the release in `docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/aformusatii/cortecho:0.3.0
```

For a fully immutable pin, use the digest from the GitHub Release instead
(`ghcr.io/aformusatii/cortecho@sha256:...`). Both avoid surprise upgrades; a
digest also survives a re-pushed tag.

## Verify the image

Every image from the pipeline carries a build provenance attestation. With an
authenticated `gh`:

```bash
gh attestation verify oci://ghcr.io/aformusatii/cortecho@<digest> -R aformusatii/cortecho
```

Release notes list the digest and the pull command.

## What to back up

`data/app.db` holds the settings, the Echoes (including their API keys), the
OpenAI key and the turn history. It is the crown jewel (while the app runs,
copy its `-wal` and `-shm` files too):

- it is never committed (`data/*.db` is gitignored);
- it must be writable by uid 1000 (the image's `node` user);
- back it up privately. The keys inside are stored plaintext.

## Ports and exposure

- Publish only the web port (`3000` by default).
- **Never expose the Echo's ports** (`26053`, `28929`, `28931`, `16700`)
  beyond the LAN.
- The Echo must be able to reach the **Reply address** (**Settings → Network**,
  `network.replyBaseUrl`) directly. Do not put a login page or a TLS redirect
  in front of it: hassmic downloads the WAV with a plain HTTP request from the
  LAN. Inside Docker the container's own address is not reachable by the Echo,
  so set this computer's LAN address once.
- If the UI is reachable from the internet, put it behind a reverse proxy with
  authentication and TLS. The UI has no authentication of its own yet.

## Health and logs

```bash
docker compose logs -f app
curl -s http://<docker-host>:3000/health | jq '.devices[] | {name, state, problem}'
```

`/health` always returns 200 while the process runs; an Echo being offline is
reported per device, so the container healthcheck does not restart a healthy
app because a device rebooted.

## Upgrades and rollback

Back up `data/app.db`, `app.db-wal` and `app.db-shm` before an upgrade. With a
pinned image, change the tag or digest and start it; with `:latest`, pull the
new release:

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically at startup and are forward-only. Releases follow
"expand, then contract": a release's migration only adds to the schema, so the
previous image still runs on the upgraded database. When a release cannot do
that, its notes say so.

To roll back an ordinary upgrade, put the previous `:X.Y.Z` or digest back in
`docker-compose.yml` and start it. If that image cannot read the migrated
schema, stop the container, restore the database files from your backup and
start again; data written since the backup is lost.

`deploy/cortecho-deploy` is an optional helper for a stage folder (a
production-like install serving real Echoes). It verifies provenance, pins a
digest in `.env`, backs up the database before each deploy, adds the previous
image as `PREVIOUS_IMAGE` and rolls back automatically when the new container
is unhealthy; `rollback --restore-db` also restores the newest backup. See
[deploy/README.md](../deploy/README.md). A plain Compose install does not need
it.

## Network discovery

Cortecho finds Echos two ways, so no special Docker network mode is required:

- a **subnet scan** of the network around the reply address, this computer and
  the existing Echos. It works on Compose's default bridge network;
- **mDNS** (`_esphomelib._tcp`), which is live and instant when multicast
  reaches the container. That needs **host networking** (or macvlan):

  ```yaml
  services:
    app:
      network_mode: host
  ```

  `DISCOVERY_EXTRA_TARGETS=192.168.1.60:26053` adds `host:port` entries for an
  Echo on another subnet (or a test FakeEcho). Ignore a discovered Echo in the
  UI and it stays hidden even if the scan sees it again.

## Changing configuration later

Only the environment-only variables are read again after the first start, among
them `OPENAI_BASE_URL`, `PUBLIC_BASE_URL`, `CORTECHO_SECRET_KEY`,
`DISCOVERY_EXTRA_TARGETS`, `MCP_ALLOWED_ORIGINS`, `MCP_CIMD_ENABLED` and the
tool variables. Everything behavioural lives in SQLite and is edited in the UI;
changing the other variables in `cortecho.env` later does nothing (the app
warns). `REPLY_AUDIO_BASE_URL` is now a setting (`network.replyBaseUrl`): an
upgrade copies it once, then edits happen in **Settings → Network**. See
[configuration](configuration.md) and [connectors](connectors.md).
