# Set up Cortecho with a coding agent

Give this page to a coding agent (Claude Code, Codex, OpenCode, …) together
with access to a machine on the same LAN as the Echo.

## What the agent must ask you for

1. The Echo's LAN address and its API key (or permission to generate one).
2. The LAN address of the machine that will run Cortecho, and a free port
   (default `3000`).
3. Your OpenAI API key, or the base URL of an OpenAI-compatible server.
4. Your time zone (an IANA name such as `Europe/Berlin`) and preferred locale.

## Steps and checks

1. **Create the folder and files.**
   ```bash
   mkdir cortecho && cd cortecho
   curl -O https://raw.githubusercontent.com/aformusatii/cortecho/main/docker-compose.yml
   curl -o cortecho.env https://raw.githubusercontent.com/aformusatii/cortecho/main/cortecho.env.example
   ```
   Check: both files exist.
2. **Fill `cortecho.env`:** `ECHO_HOST`, `ECHO_API_KEY`, `REPLY_AUDIO_BASE_URL`,
   `OPENAI_API_KEY`, `TZ`.
   Check: no secrets are printed back and the file is not world-readable.
3. **Start it:** `docker compose up -d`.
   Check: `docker compose ps` is healthy; `/health` returns 200.
4. **Run `docker compose exec app cortecho doctor`.**
   Check: every check passes, or the printed fix is applied. Treat "the Echo
   is not reachable", "the reply address is not a LAN address" and "OpenAI
   rejects the key" as blockers.
5. **Finish the settings in the UI** at `http://<host>:<port>/settings`:
   models, voice, languages, time zone, locale.
   Check: the status page shows the Echo *Connected* and its clock synced.
6. **Test:** say the wake word and ask "What time is it?".
   Check: a spoken answer and one turn with timings on the status page.

## What the agent must never do

- Change the Echo's configuration, reboot it, update it, or run
  `echo-set-key` without asking you first.
- Open a second voice-assistant client (a dev server, Home Assistant) while
  the container is running. hassmic gives the voice assistant to the first
  subscriber only.
- Expose the Echo's ports (`26053`, `28929`, `28931`, `16700`) beyond the LAN.
- Print, commit or log the OpenAI key, the Echo key or `data/app.db`.
- Edit behaviour settings in `cortecho.env` after the first start: they live in
  SQLite and are changed in the UI.
