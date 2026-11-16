# Deployment

Cortecho is one container: the API, the SPA and the SQLite database. Run it on
a machine on the same LAN as the Echo(s).

## Quick start (published image)

```bash
mkdir cortecho && cd cortecho
curl -O https://raw.githubusercontent.com/aformusatii/cortecho/main/docker-compose.yml
curl -o cortecho.env https://raw.githubusercontent.com/aformusatii/cortecho/main/cortecho.env.example
# edit cortecho.env: ECHO_HOST, OPENAI_API_KEY, REPLY_AUDIO_BASE_URL, TZ
docker compose up -d
docker compose exec app cortecho doctor
```

Then open `http://<docker-host>:3000/settings` to finish the settings that are
not in the file (models, voice, VAD, follow-ups, prompts).

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
- The Echo must be able to reach `REPLY_AUDIO_BASE_URL` directly. Do not put
  a login page or a TLS redirect in front of it: hassmic downloads the WAV
  with a plain HTTP request from the LAN.
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

## Changing configuration later

Only `REPLY_AUDIO_BASE_URL` and `OPENAI_BASE_URL` are read again after the
first start. Everything behavioural lives in SQLite and is edited in the UI;
changing those variables in `cortecho.env` later does nothing (the app warns).
See [configuration](configuration.md).
