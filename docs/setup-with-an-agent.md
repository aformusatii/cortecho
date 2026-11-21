# Set up Cortecho with a coding agent

Give this page to a coding agent (Claude Code, Codex, OpenCode, …) together
with access to a machine on the same LAN as the Echo. The agent starts the
container and hands the owner the UI link; the owner (or the agent, in the
browser) follows the setup there. No key handling is needed.

## What the agent must ask you for

1. The LAN address of the machine that will run Cortecho, and a free port
   (default `3000`).
2. Whether you use OpenAI's cloud or an OpenAI-compatible server
   (`OPENAI_BASE_URL`).
3. Optional: your time zone (an IANA name such as `Europe/Berlin`), a connector
   secret (`CORTECHO_SECRET_KEY`) and the browser-facing URL
   (`PUBLIC_BASE_URL`) — see [connectors](connectors.md).

Do **not** ask for the Echo's API key and do not run `echo-set-key`: the setup
wizard in the UI adopts the Echo and sets a key itself. Never print, commit or
log the OpenAI key, the Echo key or `data/app.db`.

## Steps and checks

1. **Create the folder and start the container.** The compose file works as
   downloaded; `cortecho.env` is optional and only for the variables that
   cannot be settings.
   ```bash
   mkdir cortecho && cd cortecho
   curl -O https://raw.githubusercontent.com/aformusatii/cortecho/main/docker-compose.yml
   docker compose up -d
   ```
   Check: `docker compose ps` is healthy; `/health` returns 200.
2. **Hand the owner the link:** `http://<host>:<port>` and ask them to follow
   **Setup** (or do it in the browser if the agent has one). The wizard:
   - finds the Echo on the network, or offers **Enter an address instead**;
   - secures the link with a key only Cortecho knows, stores it, and plays a
     sound on the Echo;
   - asks which room it is in, sets the reply address and tests it;
   - asks for the OpenAI key and checks it.
   Check: the Echo appears on the status page as *Connected · Secured*; the
   settings show a non-empty **Reply address** under **Settings → Network**.
3. **Run the doctor:** `docker compose exec app cortecho doctor`.
   Check: every check passes, or the printed fix is applied. Treat "the Echo
   is not reachable", "the reply address is not a LAN address" and "OpenAI
   rejects the key" as blockers.
4. **Test:** say the wake word and ask "What time is it?".
   Check: a spoken answer and one turn with timings on the status page.

## What the agent must never do

- Run `echo-set-key`, remove a key, or otherwise change the Echo's
  configuration, reboot it or update it without asking the owner first. The
  wizard's adoption is the one change, and it only secures an Echo that has no
  key yet.
- Open a second voice-assistant client (a dev server, Home Assistant) while
  the container is running. hassmic gives the voice assistant to the first
  subscriber only.
- Expose the Echo's ports (`26053`, `28929`, `28931`, `16700`) beyond the LAN.
- Print, commit or log the OpenAI key, the Echo key or `data/app.db`.
- Edit behaviour settings in `cortecho.env` after the first start: they live in
  SQLite and are changed in the UI.
