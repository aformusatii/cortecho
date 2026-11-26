# Development

Cortecho is a TypeScript monorepo: a Hono API, a React/TanStack SPA, and shared
Zod schemas. Node.js 24 runs the `.ts` files directly (type stripping).

## Commands

Run everything from the repository root.

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run dev` | API on `:3000` (`node --watch`) + Vite on `:5173`. With no device, no ESPHome client starts |
| `npm run fake-echo -- q.wav [--port 26099] [--out a.wav] [--key b64]` | Fake hassmic on localhost: plays a WAV as a wake-word run, downloads and saves the spoken answer |
| `npm run echo-set-key -- --host 192.168.1.50` | **Changes the Echo**: gives it an API key, once. CLI fallback; the UI adopts Echos itself. Ask before running it |
| `npm run build` / `npm start` | Production build / server (API + SPA on `:3000`) |
| `npm run typecheck` | `tsc --noEmit` for every workspace and `e2e/` |
| `npm run lint` | Biome lint + format check (`npm run format` fixes) |
| `npm test` | Vitest: shared + API (unit + FakeEcho integration, no network) |
| `npm run test:e2e` | Playwright against a production build, 3 viewports, two FakeEchos, no real Echo, no OpenAI key |
| `npm run test:smoke` | Production smoke tests against the deployed Cortecho (see below) |
| `npm run test:onboarding` | Docker onboarding E2E in the `cortecho-onboarding` Compose project (see below) |
| `npm run smoke:init` | Generate the simulated Echo's identity (`smoke/.env.smoke`, once) |
| `npm run doctor` | Read-only configuration/link check (same as `cortecho doctor`) |
| `npm run db:generate` | New migration after editing `apps/api/src/db/schema.ts` |

**Before you call a change done:** `npm run typecheck && npm run lint && npm test`
must pass. Run `npm run test:e2e` when the UI or HTTP behaviour changes.

## Layout

```
packages/shared/src/      Zod schemas + types used by BOTH api and web
apps/api/src/
  server.ts               entry: config → db → settings import → devices → tools → services → HTTP
  app.ts                  createApp({ db, voice }): middleware, /health, routes, errors
  env.ts / config.ts      environment-only configuration
  esphome/                protobuf, messages, framing, Noise, time zone, client, FakeEcho,
                          adopt.ts (probe + SetKey for the setup wizard)
  vad/                    energy VAD: ends requests, as Home Assistant's VAD does
  features/settings/      SQLite settings, overrides, validation, one-time import, HTTP routes
  features/devices/       SQLite devices, one client + pipeline per Echo, adopt/secure, HTTP routes
  features/discovery/     mDNS and subnet scan of Echos, the ignore list, HTTP routes
  features/setup/         onboarding state and the OpenAI check, HTTP routes
  features/turns/         SQLite turn history (newest 1000)
  features/voice/         /api/turns, /api/say, /api/ask, /api/reply-audio
  pipeline/               services, OpenAI, agent, sessions, prompt layers, turn state machine
  tools/                  registry + one file per tool plugin
  scripts/                fake-echo, echo-set-key, doctor
apps/api/drizzle/         generated SQL migrations (committed, never edited by hand)
apps/web/src/             routes, features/{status,settings,devices,voice,setup}, ui
e2e/                      Playwright specs, helpers, FakeEcho server
docs/                     user and contributor documentation
```

## Testing

- **Unit** (`esphome/protocol.test.ts`): protobuf codec, plaintext and Noise
  framing (split chunks, hassmic's "requires encryption" frame), the Noise
  handshake both ways and with a wrong key, POSIX TZ rules. Also VAD, tool
  registry, agent tool loop and memory, audio helpers.
- **Integration** (`pipeline/voice-pipeline.test.ts`): a fake hassmic
  (`esphome/fake-echo.ts`) covers a normal turn, events in Home Assistant's
  order, the WAV fetch, `AnnounceFinished`, follow-ups, silence guards,
  aborts, OpenAI failures, disconnects, reconnects, the time request (plaintext
  vs keyed), refused plaintext, wrong keys and `/say`. OpenAI is faked; no
  network.
- **E2E** (`e2e/`): the production build without `ECHO_HOST` and without an
  API key at three viewports (375, 768, 1280). Playwright starts two FakeEchos
  and creates devices through the API, so add/edit/override/delete and Say run
  without hardware. It also rewrites `docs/screenshots/*.png`; review and
  commit those deliberately.
- **Against the real hassmic** (manual): its PC build
  (`make build/hassmic-host` in the echo-dot-assist checkout, needs
  `libopus-dev`) runs in ESPHome mode. Set `HASSMIC_FAKE_ADDRS` to the
  addresses the app connects to, or hassmic drops the link. A wake word is
  `SIGUSR1`.
- **Manual with real OpenAI:** `npm run fake-echo -- question.wav`.

No test needs the real Echo, an OpenAI key or the internet.

## Production smoke tests

`smoke/` is a separate test suite that drives the **deployed** Cortecho,
unchanged, through the same interface a real Echo uses. It is not a workspace
and is never part of `npm test` or CI — it needs keys, the production
deployment and money.

- `npm run smoke:init` — generate the simulated Echo's identity (a 32-byte
  Noise key, a node name and a MAC) and write `smoke/.env.smoke` from the
  tracked example. Add your own `SMOKE_OPENAI_API_KEY` by hand.
- `npm run test:smoke` — run every scenario; `-- scenarios/tool-action` runs one
  file, `-t "<name>"` one test. `SMOKE_YES=1` lifts the cost guard
  (`SMOKE_MAX_TURNS`, default 20 voice turns), `SMOKE_FORCE=1` lifts the run
  lock. Announcements to all Echos (`@audible`) also play on the real Echo;
  `npm run test:smoke -- -t '^(?!.*every Echo)'` runs everything else (at
  night, say). The tool-action scenario really saves a mail draft, tagged with the
  run's two-word tag ("smoke test amber falcon passed").
- The simulated mic matches the real Echo's (measured 2026-11-18): 800 ms of
  lead-in, the Echo's ~650 ms wake chime at the start of every run, room noise
  at `SMOKE_ROOM_DBFS` (-60), and an answer 1 s after a follow-up opens.
- Each run writes `smoke/.runs/<run id>/report.md` plus per-step WAVs, wire
  events, transcripts and logs. The suite reads `report.md` first.

The simulated Echo is `apps/api/src/esphome/fake-echo.ts` (`timing: 'real'`);
the smoke harness lives in `smoke/harness/`. Mail verification/cleanup
(§6.4) is an interface with a `skip` implementation until `SMOKE_MAIL_*` is
configured — it reports "skipped", never fails.

## Onboarding E2E (on demand)

The onboarding suite in `onboarding/` proves that a fresh install of the shipped
Docker image onboards a brand-new Echo Dot (hassmic / ESPHome native API) end
to end, as on a home LAN:

- Cortecho is the real image from the repository `Dockerfile`, with an empty
  data volume, no API key and no `ECHO_*` or `DISCOVERY_EXTRA_TARGETS`.
- The Echo is `FakeEcho` in `timing: 'real'` on port 26053, unkeyed, behind a
  small control API (`/wake`, `/drop`, `/reboot`, media and state).
- Discovery is the real /24 TCP scan on 26053. The runner opens the page at
  Cortecho's IP, so the wizard's scan hint and its reply address prefill are
  the lab network's `.10`.
- Adoption is the real probe and Noise `SetKey`; the chime and the voice reply
  are really downloaded from `http://<cortecho>:3000`.
- The OpenAI check is server-side. `openai-gw` is the only container with
  internet: in `mock` mode it answers deterministically; in `real` mode it
  proxies to OpenAI with `OPENAI_API_KEY_E2E`, so the real key never reaches
  Cortecho, the browser, the video or the trace.

Run it locally (Docker required):

```bash
npm run test:onboarding                                  # mock OpenAI, no cost
OPENAI_MODE=real OPENAI_API_KEY_E2E=sk-... npm run test:onboarding
CORTECHO_IMAGE=ghcr.io/owner/cortecho:latest npm run test:onboarding
```

It writes `onboarding/out/`: `summary.md`, the self-contained Playwright HTML
report with videos and traces (`report/`), one screenshot per step (`steps/`),
the Echo's media (`media/`), `facts.json`, `openai-calls.json` and `logs/`.
The suite starts only containers, networks and the volume in the
`cortecho-onboarding` project and removes them with `down -v` afterwards.

In Actions, run **Onboarding E2E** with `openai=real|mock` (default `real`) and
an optional `image` (empty = build this ref). Every run uploads the report
artifact. Runs on `main` also publish the report to GitHub Pages.

What it does **not** prove: `FakeEcho` models hassmic, not the Echo hardware,
firmware, microphone, speaker or the local wake-word engine. It does not test a
real Wi-Fi link, mDNS (the scan is the path under test), or a real Echo's
physical reboot. Those remain the production smoke suite and manual checks.

## Adding a tool

A new action is one file plus one registration:

```ts
// apps/api/src/tools/plugins/garage-door.ts
import type { Tool } from '../registry.ts';

export function garageDoorTool(url: string | undefined): Tool | null {
  if (!url) return null;                       // not configured → not registered
  return {
    name: 'garage_door_state',                 // snake_case, unique
    description: 'Says whether the garage door is open or closed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    // destructive: true,                      // changes the real world
    handler: async (_args, { signal }) => (await fetch(url, { signal })).json(),
  };
}
```

Register it in `tools/index.ts`, put the variable in `config.ts` and document
it, add a test in `tools/registry.test.ts`, and list it in the README. Mark it
`destructive: true` if it changes anything in the real world; destructive
tools are hidden from the model and refused unless their name is in
`TOOLS_ALLOW_DESTRUCTIVE`.

Rules: the model only ever picks **names** from fixed lists, never URLs or
command lines. Never give a tool access to adb or the Echo's update key.

## Adding a setting

One descriptor in `packages/shared/src/settings.registry.ts` (key, label,
help, Zod schema, default, control, unit, bounds, per-Echo flag, env name) plus
the code that reads it from the turn's `Settings` snapshot. The UI forms are
generated; the registry test checks the bounds agree with the schema. Never
add a behaviour setting to `config.ts`.

## Adding an ESPHome message

Add the id and encode/decode in `esphome/messages.ts`, handle it in
`EsphomeClient.handleMessage` (link level) or emit it to `VoicePipeline`
(voice). `DeviceManager` owns identity (`device-info`). Teach `FakeEcho` to
send/answer it and cover it in `voice-pipeline.test.ts`. Check hassmic's
`proto_esphome.c` first; the code wins over docs. Never add device-admin
messages.

## Dependencies

On top of the template: **`openai`** (OpenAI transcription, Responses API and
speech). ElevenLabs is called with plain `fetch` (no SDK), so it adds no
dependency. The ESPHome protobuf subset, the Noise handshake (on
`node:crypto`), VAD, WAV and resampling are hand-written. The runtime image needs `tzdata` for the POSIX
time zone rule.

## Branding assets

`apps/web/public/logo.svg` is the app mark and the source for `npm run icons`.
The wordmarks and social preview are in `docs/img/`: `logo-light.svg` and
`logo-dark.svg` are shown in the README, `social-preview.svg` is the source for
`social-preview.png` (uploaded by hand in the repository settings). The images
in `docs/screenshots/` are regenerated by `npm run test:e2e`.

The README diagrams (`docs/img/diagrams/architecture-*.svg` and
`turn-sequence-*.svg`, light and dark) are generated: edit
`docs/img/diagrams/build.mjs`, run `node docs/img/diagrams/build.mjs` and
commit the SVGs with it. Never edit the SVGs by hand. Keep the sequence in step
with [How a turn works](protocol.md).

## Template lineage

The project started from the `tpl-node-webapp` template (Hono + React SPA +
SQLite + Docker). Its patterns (shared Zod contract, `AppError`, repository +
routes + tests per feature) still apply; the template's Users example was
removed.
