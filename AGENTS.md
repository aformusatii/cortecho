# AGENTS.md

Guidance for AI coding agents (and humans) working on Cortecho.

**Cortecho** is the Node.js "brain" of a rooted Amazon Echo Dot. The Echo runs
`hassmic` from [echo-dot-assist](https://github.com/Gamer92000/echo-dot-assist),
which is an **ESPHome native API server** (TCP 26053). Cortecho is its **voice
assistant client**: mic audio → speech-to-text → agent with tools →
text-to-speech → a WAV URL the Echo downloads and plays. It also answers the
Echo's time requests, asks follow-up questions without the wake word, and makes
announcements (`/api/say`). One process serves several Echos.

Read [README.md](README.md) for the user-facing overview and [docs/](docs/) for
the protocol, configuration, deployment and Echo procedures.

## Commands

Run everything from the repository root.

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run dev` | API on `:3000` (`node --watch`) + Vite on `:5173`. With no device, no ESPHome client starts |
| `npm run fake-echo -- q.wav [--port 26099] [--out a.wav] [--key b64]` | Fake hassmic on localhost: plays a WAV as a wake-word run, downloads and saves the answer |
| `npm run echo-set-key -- --host 192.168.1.50` | **Changes the Echo**: gives it an API key, once (fallback; the UI adopts Echos itself). Ask the owner first |
| `npm run build` / `npm start` | Production build / server (API + SPA on `:3000`) |
| `npm run typecheck` | `tsc --noEmit` for every workspace and `e2e/` |
| `npm run lint` | Biome lint + format check (`npm run format` fixes) |
| `npm test` | Vitest: shared + API (unit + FakeEcho integration, no network) |
| `npm run test:e2e` | Playwright against a production build, 3 viewports (two FakeEchos, no real Echo, no OpenAI key) |
| `npm run test:smoke` | **Production smoke tests**: a simulated Echo ("Test Echo") against the *deployed* Cortecho, real OpenAI. Never in CI; needs `smoke/.env.smoke`, the deployment and money. **Ask the owner first** (see Smoke tests below) |
| `npm run test:onboarding` | **Docker onboarding E2E**: a fresh install of the shipped image, the real /24 scan and voice turn, all inside the `cortecho-onboarding` Compose project. Mock OpenAI by default; `OPENAI_MODE=real` needs `OPENAI_API_KEY_E2E` |
| `npm run smoke:init` | Generates the simulated Echo's identity and writes `smoke/.env.smoke` (once) |
| `npm run doctor` | Read-only configuration/link diagnostics |
| `npm run db:generate` | New migration after editing `apps/api/src/db/schema.ts` |

**Before you call any change done:** `npm run typecheck && npm run lint && npm test`
must pass. Run `npm run test:e2e` when the UI or HTTP behaviour changes.
After a deploy that changes voice behaviour, offer the owner a smoke run.

### Smoke tests (`smoke/`)

The suite drives the deployed Cortecho through the same ESPHome interface a
real Echo uses: the test's text becomes speech (the suite's own OpenAI key),
streams in as mic audio, and the reply is downloaded and transcribed back.
Cortecho knows the simulator only as one more `kind: echo` device named
"Test Echo"; its per-Echo prompt and overrides are mirrored from the real Echo.
Guide: [docs/development.md](docs/development.md#production-smoke-tests).

- **Ask before running it.** It changes production state (enables the Test
  Echo device, writes its per-Echo settings), costs OpenAI money per turn
  (`SMOKE_MAX_TURNS` guards a run, default 20), and has real side effects (the
  tool-action scenario saves a mail draft). The `@audible` all-Echos announcement
  plays on the real Echo in the house; `-- -t '^(?!.*every Echo)'` skips it.
- **No test modes in Cortecho.** Never add a flag, header or device property
  that makes the app treat the Test Echo differently. The difference is the
  device name only.
- One run at a time; the harness sets the Test Echo up once per run and
  disables it at the end (also on Ctrl-C, via `globalSetup`). It never touches
  the real Echo's row, its per-Echo settings or global settings.
- Read `smoke/.runs/<run id>/report.md` first (dialogue as heard, outcome,
  wire, timings, pass/fail); open a step's `server.log`, `echo.log`, WAVs or
  `turn.json` only for a failure.
- **When the suite and the real Echo disagree, the suite is wrong.** The
  simulator is `FakeEcho` in `timing: 'real'` with the smoke mic options
  (`wakeSoundDbfs`, `roomNoiseDbfs`); unit tests use it in `'fast'` timing, so
  a fidelity fix lands in both. Keep what the real Echo does: the 800 ms
  lead-in and its ~650 ms wake chime open **every** run, the room is noise
  (~-60 dBFS), never digital silence, one mic stream (spoken words replace
  room audio), room audio outlasts hassmic's 30 s, and a person answers a
  follow-up about 1 s after it opens. Check `main.c` / `proto_esphome.c`
  before modelling a new behaviour.
- **New scenario:** `smoke/scenarios/<area>.smoke.ts`, plain Vitest with
  `useSmokeEcho()` and its primitives (`wake`, `answer`, `stayQuiet`,
  `pressButton`, `bargeIn`, `dropLink`, `announce`). Write the requests as the
  owner would say them, assert on what Cortecho did (`turn.outcome`,
  `listensAgain`, the transcribed `said`, server log lines), not on the
  simulator's own flags, and tolerate the model's wording. Spoken side effects
  carry `echo.tag` so they can be found and cleaned up.

**Before changing configuration docs:** the runtime has three layers (SQLite
settings, devices, env-only). Read [docs/configuration.md](docs/configuration.md)
first; behaviour settings are never read from the environment after the
one-time import.

## Folder structure

```
packages/shared/src/      Zod schemas + types used by BOTH api and web
apps/api/src/
  server.ts               entry: config → db → settings import → devices → tools → services → HTTP
  app.ts                  createApp({ db, voice }): middleware, /health, routes, errors (no listen)
  env.ts / config.ts      environment-only configuration (no behaviour settings)
  lib/logger.ts           one-line leveled logger (LOG_LEVEL); never log secrets or audio
  esphome/
    protobuf.ts           the protobuf subset the API needs (writer + reader)
    messages.ts           message ids, VA events/flags, encode/decode
    framing.ts            plaintext and Noise frames, transport codec
    noise.ts              Noise_NNpsk0_25519_ChaChaPoly_SHA256 on node:crypto
    timezone.ts           POSIX TZ rule of an IANA zone, for GetTimeResponse
    client.ts             EsphomeClient: one socket, hello/subscribe, ping, time, reconnect
    adopt.ts              probe (Hello + DeviceInfo) and SetKey adoption; CLI and manager share it
    mac.ts                MAC normalisation (12 lower-case hex) for discovery and adoption
    fake-echo.ts          FakeEcho (hassmic on localhost); also the smoke suite's simulated Echo
  vad/end-of-speech.ts    energy VAD (adaptive noise floor): ends requests, as HA does
  features/settings/      SQLite store, per-Echo overrides, validation, one-time import, routes
  features/devices/       SQLite CRUD, one client + pipeline per Echo, identity checks, adopt/secure, routes
  features/providers/     ElevenLabs voices/models, voice preview proxy, provider key checks, routes
  features/discovery/     mDNS browse + subnet probe, ignore list, /api/discovery routes
  features/setup/         onboarding state (app_state) and the OpenAI check, /api/setup routes
  features/turns/         SQLite history (newest 1000)
  features/voice/         /api/turns, /api/say, /api/ask, /api/reply-audio
  doctor/                 read-only checks behind the CLI and GET /api/doctor
  pipeline/               services, agent, sessions, prompt layers, turn state machine
  pipeline/providers/     OpenAI (STT/TTS/Responses) and ElevenLabs (STT/TTS) implementations
  tools/                  registry, index, plugins/*.ts
  scripts/                fake-echo, echo-set-key, doctor
apps/api/drizzle/         generated SQL migrations - committed, never edited by hand
apps/web/src/
  routes/                 thin TanStack file routes
  features/{status,settings,devices,voice,setup}/  pages, queries, components
                          (setup: onboarding, the shared Add Echo flow, Discovered cards)
  components/, lib/       app shell + nav, ui/, api-client, query-client, displays
e2e/                      Playwright specs, helpers, FakeEcho server
smoke/                    production smoke tests (not a workspace; not in `npm test` or CI)
  harness/                setup/lifecycle + scenario API (smoke-echo.ts), Cortecho HTTP client,
                          voice (TTS cache, levels, transcription), report, matchers, cleanup
  scenarios/              *.smoke.ts, one file per area
  .env.smoke.example      every SMOKE_* variable; the real .env.smoke, .runs/, .cache/ are gitignored
onboarding/               on-demand Docker onboarding E2E: echo-sim, OpenAI gateway, Playwright
                          runner and run.sh (not a workspace; results in onboarding/out/)
docs/                     user and contributor documentation
```

## How to extend

- **New tool (most common):** add `apps/api/src/tools/plugins/<name>.ts`
  exporting a function that returns a `Tool` or `null` (when not
  configured), register it in `tools/index.ts`, put its variable in
  `config.ts` + `docs/configuration.md`, add a test in
  `tools/registry.test.ts`, and list it in the README. Mark it
  `destructive: true` if it changes anything in the real world.
- **New ESPHome message:** id and encode/decode in `esphome/messages.ts`,
  handle it in `EsphomeClient.handleMessage` (link-level) or emit it to
  `VoicePipeline` (voice); the `DeviceManager` handles identity (`device-info`).
  Teach `FakeEcho` to send/answer it, and cover it in `voice-pipeline.test.ts`.
  Check hassmic's `proto_esphome.c` first (the code wins over docs), and keep
  device-admin messages out (see Rules).
- **New HTTP endpoint:** schema in `packages/shared/src/voice.schema.ts` (or
  `device.schema.ts`), route in `features/voice/voice.routes.ts` or
  `features/devices/devices.routes.ts` (or a new `features/<name>/`),
  test with `createTestRuntime()` + `app.request()`.
- **New device behaviour:** the `DeviceManager` owns the runtime map and the
  identity checks; routes go through it, never build a second `EsphomeClient`
  for the same `host:port`.
- **New setting:** one descriptor in `packages/shared/src/settings.registry.ts`
  (key, label, help, Zod schema, default, control, unit, bounds, per-Echo flag,
  env name) plus the code that reads it from the turn's `Settings` snapshot.
  The UI forms are generated from the descriptor; the registry test checks the
  bounds agree with the schema. Never add a behaviour setting to `config.ts`.
- **New web page:** a thin file in `apps/web/src/routes/` (TanStack file routes;
  run `npm run build -w @cortecho/web` to regenerate `routeTree.gen.ts` before
  typechecking) and the page + queries/components in
  `apps/web/src/features/<name>/`. Query keys are namespaced (`['settings']`,
  `['devices']`, `['devices', id]`, `['status']`, `['mcp']`); a write
  invalidates the namespaces it touches. Keep secrets write-only (`hasKey`) and
  use `apiRequest` + `ApiError.fields` for form errors.
- **New connector type:** one entry in `packages/shared/src/mcp.catalog.ts`
  (URL, auth quirks, scopes, guide anchor) and a `docs/connectors.md` section.
  No new code: the Add dialog and the form are generated from the catalog.
- **Realtime API mode:** a new implementation next to `pipeline/providers/openai.ts`
  behind a `PIPELINE_MODE` setting; keep the turn-based pipeline as the
  fallback. Needed before `gpt-4o-mini-tts` shuts down on 2027-01-06.

## MCP connector invariants (do not break)

- **One connection per server row.** Never open a second `McpConnection` for the
  same `mcp_servers` row; the manager owns the runtime map.
- **Connections open at startup and after a change, never during a turn.** A
  turn reads a memory-only tool snapshot. A connector that is down is left out
  of that turn (the prompt marks it unavailable).
- **Tool snapshot per turn.** `ToolRegistry.snapshot({settings, deviceId})` is
  taken where the settings snapshot is taken. A mid-turn connector change does
  not change the turn.
- **Secrets never leave the database decrypted.** `headers_enc`,
  `oauth_client_secret_enc` and the credential columns are encrypted with
  `CORTECHO_SECRET_KEY` (AES-256-GCM). Responses expose only `hasHeaders` /
  `hasClientSecret`; never log token payloads, tool arguments or results at
  `info`.
- **Confirm is a code barrier, not a prompt rule.** A `confirm` tool stores a
  pending action on the speaker's session and refuses the same turn; only a
  later turn with the same arguments may run it.
- **Definition pinning.** A changed tool hash is `off` until the owner approves
  it; a tool added after the first sync starts `off` and is marked new.
- **`stdio` is environment-only.** Do not add a UI path that runs commands.
- **The URL policy is checked on save and on every connect** (HTTPS, LAN-only
  plain HTTP, no link-local/metadata, no Echo ports, DNS resolved).

## Protocol invariants (do not break)

- Each Echo is the server; open **exactly one** connection **per Echo** and
  subscribe to the voice assistant after **every** connect. hassmic gives the
  voice assistant to the first subscriber only. `devices` is unique on
  `(host, port)` so one Echo cannot be opened twice; never run a second client
  (a dev server pointed at an enabled Echo, Home Assistant) next to the
  deployed container — disable the device first, which closes its link.
- Every device's snapshot is taken at the **start of its turn**; a settings
  change applies from the next turn, link timings from the next connect.
  `AgentSessions` is one map in the runtime (`device:<id>` / `web`), never one
  per pipeline.
- Every turn ends with `RUN_END` (after the reply was handed over) or
  `ERROR` + `RUN_END`. `stt-no-text-recognized` ends quietly, any other code
  plays the error sound. hassmic gives up after more than 30 s in one state
  (listening or thinking, `PIPELINE_TIMEOUT`): the turn deadline (24 s from the
  end of speech) and the follow-up listen cap (27 s) must stay under it.
- **We end listening** (our VAD), as Home Assistant's VAD does: hassmic's
  own end detection (`end_of_request`) is experimental and off by default,
  so the Echo usually streams until we send `STT_VAD_END`.
- `STT_START` only at the start of a run, before `STT_VAD_END` (hassmic
  would listen again with the mic closed). `INTENT_END` with
  `continue_conversation=1` only right before a reply that will play. The model
  decides that by calling `listen_for_reply` (`followUp.mode=tool`); answer it
  in the agent, never with a second model round when text came with it.
- After `VoiceAssistantRequest{start:false}` send nothing more for that run.
- Replies: a URL in `TTS_END` (and announcements), **WAV or MP3 only**,
  reachable from the Echo on the LAN (the **Reply address** setting,
  `network.replyBaseUrl`, read from the turn's settings snapshot; never a
  public URL). The endpoint serves only a current reply by its random id (one
  per Echo); a device's reply is revoked when it starts the next one, is
  stopped, deleted or replaced. `REPLY_AUDIO_BASE_URL` is only its one-time
  upgrade import; a turn must not read the environment.
- `GetTimeResponse.epoch_seconds` is a fixed32; hassmic sets its clock from
  it **only** over the keyed (Noise) link. Encrypted messages we send stay
  under 8 KiB (hassmic drops larger ones).
- Never send device-admin messages (update install, adb switch, reset/restart
  buttons, settings writes) from the app.
- **`SetKey` is the one exception, and only to adopt an Echo**, as Home
  Assistant does: the app sends `NoiseEncryptionSetKeyRequest` with a new
  random key only to an Echo that has **no key yet**, over a zero-PSK Noise
  link (never plaintext), only when the owner adds that Echo in the UI, and
  stores the key before the link restarts with it. Never rotate or clear a key
  from the app (an empty key would open the Echo to plaintext again); removing
  a key stays a manual step on the Echo. The `DeviceManager` does the adoption
  with the device's own link closed, so there is still one connection per Echo.
  `echo-set-key` stays as a CLI fallback and shares the same handshake code.

## Conventions

- **Explicit over clever.** Plain functions and small classes, one concern per file.
- **Comments explain WHY**, at the decisions a reader could trip on.
- **Shared schemas are the contract** for request bodies and query strings.
- **Errors** have the shape `{ error: { code, message, fields? } }`; throw `AppError`.
- **TypeScript must be erasable** (Node strips types): no `enum`, no
  `namespace`, no constructor parameter properties; `import type` for types,
  `.ts` extensions in relative imports. `noUncheckedIndexedAccess` is on.
- **ESM everywhere**, Node 24.
- shadcn components: `npx shadcn@latest add <name> -c apps/web`.

## Rules

- **Secrets never enter git, the image, logs or the app's config:**
  `cortecho.env`, `.env`, `secrets.*`, `data/*.db`, `echo-dot-assist/` (the
  Echo's update key and Wi-Fi config) are gitignored and dockerignored. Never
  print or cat them, and never stage them.
- **The Echo is a real device that can be bricked.** Ask the owner before
  anything that changes it (config, reboot, updates). Reading logs/status is
  fine. Follow the device rules in [docs/echo-setup.md](docs/echo-setup.md)
  and log every command run on it.
- **Never expose the Echo's ports** (26053, 28929, 28931, 16700) beyond the
  LAN. Anything public goes through an authenticated reverse proxy.
- **Check current docs before using a library or OpenAI API** (Context7 MCP).
  OpenAI model names and audio formats change often.
- Ask before long or expensive OpenAI runs (load tests).
- Migrations: edit `schema.ts`, run `npm run db:generate`, commit the new SQL.
  Never edit an applied migration.
- The owner's own notes live in the gitignored `AGENTS.local.md`; do not copy
  them into tracked files.
