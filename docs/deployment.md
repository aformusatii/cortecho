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

The published image is `ghcr.io/aformusatii/cortecho:latest`. Building from
source is for development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## What to back up

`data/app.db` holds the settings, the Echoes (including their API keys), the
OpenAI key and the turn history. It is the crown jewel:

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

## Upgrades

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically at startup. Back up `data/app.db` before a major
upgrade.

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
