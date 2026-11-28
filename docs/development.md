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
| `npm run typecheck` | `tsc --noEmit` for every workspace, `e2e/`, `smoke/`, `onboarding/` and `deploy/` |
| `npm run lint` | Biome lint + format check (`npm run format` fixes) |
| `npm test` | Vitest: shared + API + onboarding helpers + scripts + deploy (unit and FakeEcho integration, no network) |
| `npm run test:e2e` | Playwright against a production build, 3 viewports, a fresh database per project, FakeEchos only (see the pyramid below) |
| `npm run test:integration` | The Docker integration lab in the `cortecho-onboarding` Compose project: onboarding, restart, both provider turns, a follow-up, "Listen here" in WebKit, an announcement, the UI tour and the evidence assets |
| `DEPLOY_INTEGRATION=1 npx vitest run --project deploy` | The gated deploy-script integration test (throwaway stage, fake `docker`/`gh`); skipped in `npm test` |
| `npm run test:smoke` | Production smoke tests against stage, on request (see below) |
| `npm run smoke:init` | Generate the simulated Echo's identity (`smoke/.env.smoke`, once) |
| `npm run doctor` | Read-only configuration/link check (same as `cortecho doctor`) |
| `npm run db:generate` | New migration after editing `apps/api/src/db/schema.ts` |
| `deploy/cortecho-deploy <command>` | Stage deploys only, on request: `pr <N>`, `main`, `version <X.Y.Z>`, `rollback [--restore-db]`, `status` |

**Done locally:** `npm run typecheck && npm run lint && npm test` must pass;
also run `npm run test:e2e` when the UI or HTTP behaviour changes. The PR's
required checks are the verdict (see [Pull requests and releases](#pull-requests-and-releases)).

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
onboarding/               the Docker integration lab: echo-sim, AI gateway, Playwright runner
scripts/                  next-version.mjs (release SemVer from PR titles), ghcr-cleanup.mjs
deploy/                   cortecho-deploy (stage deploy, rollback, status) and its tests
.github/workflows/        ci, docker-image, release, ghcr-cleanup, pr-title, onboarding-e2e
docs/                     user and contributor documentation
```

## Testing

The pyramid: variations at the bottom, the basics plus screenshots in the lab.
No layer repeats the one below.

| Layer | Covers | Runs | How |
|---|---|---|---|
| Unit | Protobuf, Noise, VAD, settings, tools, MCP, providers, the FakeEcho voice pipeline, release/cleanup/deploy scripts | Local; PR check `ci` | `npm test` |
| E2E | The UI and HTTP flows at 3 viewports | Local; PR check `ci` | `npm run test:e2e` |
| Integration lab | A fresh Docker install, onboarding, the voice basics, UI screenshots | PR check `integration`; manual | `npm run test:integration` |
| Production smoke | The real deployment (stage) through the ESPHome interface | Manual, on request | `npm run test:smoke` |
| Manual real hassmic | The Echo software build, on a real LAN | Manual | see below |

### Unit (Vitest)

`npm test` runs the shared, API, onboarding-helper, script and deploy projects;
no network. It includes `esphome/protocol.test.ts` (protobuf codec, plaintext
and Noise framing, the Noise handshake both ways and with a wrong key, POSIX TZ
rules) and `pipeline/voice-pipeline.test.ts` (a FakeEcho covers a normal turn,
events in Home Assistant's order, the WAV fetch, follow-ups, silence guards,
aborts, disconnects, reconnects, the time request, wrong keys and `/say`). OpenAI
is faked. The deploy script's integration test is gated:
`DEPLOY_INTEGRATION=1 npx vitest run --project deploy` (throwaway stage, fake
`docker`/`gh`; never in `npm test`).

### E2E (Playwright)

`npm run test:e2e` builds the production app once and runs the mobile (375),
tablet (768) and desktop (1280) projects in separate invocations, so each gets
a fresh `data/e2e.db`. There is no `ECHO_HOST` and no OpenAI key; four FakeEchos
and a FakeMCP server run on localhost (two are discoverable), and devices are
created through the API, so add/edit/override/delete, Say and connectors run
without hardware. The tests rewrite `docs/screenshots/*.png`; review and commit
those deliberately. CI fails a test that passed only on retry
(`failOnFlakyTests`).

### Integration lab (Docker)

The lab in `onboarding/` runs a fresh install of an image on a private /24: a
real subnet scan, the wizard and Noise `SetKey`, a restart, then the eight
basics — onboarding (with screenshots), still connected and encrypted after the
restart, one OpenAI turn, one ElevenLabs turn, one follow-up, one announcement,
"Listen here" in WebKit, and the UI tour at 1280 and 375 (one screenshot per
page, fail on console errors or failed requests). AI is mock by default through
`openai-gw`, the only container with egress.

Every PR runs it in the required `integration` job against the exact digest the
`image` job built (no second build, no secrets; a fork PR is built locally
instead, without a registry push). The job uploads `digest.txt`,
`summary.json`, `evidence.html`, `integration-report.zip`, `results.json`,
`junit.xml` and `sbom.spdx.json`, and the release reuses that evidence for the
same digest. Run it locally (Docker required):

```bash
npm run test:integration                                 # mock providers, no cost
OPENAI_MODE=real OPENAI_API_KEY_E2E=sk-... npm run test:integration
CORTECHO_IMAGE=ghcr.io/aformusatii/cortecho@sha256:... npm run test:integration
```

`OPENAI_MODE=real` uses real keys only inside the gateway; without
`ELEVENLABS_API_KEY_E2E` the ElevenLabs scenarios skip with a reason. Output is
`onboarding/out/` (`summary.md`, the HTML report with videos and traces, one
screenshot per step, the Echo's media, `facts.json`, `openai-calls.json` and
logs). The suite creates and removes only the `cortecho-onboarding` project.
The on-demand **Onboarding E2E** workflow (`onboarding-e2e.yml`) runs the same
lab with real AI and publishes the report; sets `image` to test an existing
image instead of building the ref.

What it does **not** prove: `FakeEcho` models hassmic, not the Echo hardware,
firmware, microphone, speaker or wake-word engine. It does not test a real
Wi-Fi link, mDNS (the subnet scan is the path under test), or a physical
reboot. Those remain the production smoke suite and manual checks.

### Production smoke (stage, on request)

`smoke/` drives the **deployed** Cortecho on stage, unchanged, through the same
interface a real Echo uses. It is not a workspace and never runs in `npm test`
or CI: it needs keys, the deployment and money, and it changes production state
(it enables a "Test Echo" device). **Ask the owner first.**

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
- `scenarios/providers.smoke.ts` exercises the per-Echo provider overrides: it
  sets the Test Echo's own `stt.provider` / `tts.provider`, says "What time is
  it?" for each ElevenLabs combination, checks the per-turn provider log line
  and the played reply, then previews "Listen here" and an announcement through
  ElevenLabs. It only writes the Test Echo's overrides and restores them in
  `afterEach`; the real Echo and the global settings are untouched. When the
  deployment has no ElevenLabs key (`hasKeys['elevenlabs.apiKey']` false) the
  ElevenLabs tests are skipped with that reason, never failed.

The simulated Echo is `apps/api/src/esphome/fake-echo.ts` (`timing: 'real'`);
the smoke harness lives in `smoke/harness/`. Mail verification/cleanup
(§6.4) is an interface with a `skip` implementation until `SMOKE_MAIL_*` is
configured — it reports "skipped", never fails.

### Manual, real hassmic

For the Echo software itself, use hassmic's PC build: `make build/hassmic-host`
in the echo-dot-assist checkout (needs `libopus-dev`), in ESPHome mode. Set
`HASSMIC_FAKE_ADDRS` to the addresses the app connects to, or hassmic drops the
link. A wake word is `SIGUSR1`; `npm run fake-echo -- question.wav` exercises the
loop with real OpenAI. This is the only layer that touches the code the Echo
runs, and it stays manual.

No test in `npm test`, `test:e2e` or the integration lab needs the real Echo, an
OpenAI key or the internet.

## Pull requests and releases

1. Branch from `main`, make the change, run the local gates (above).
2. Open a PR with a **Conventional Commit title**. It becomes the squashed
   commit on `main` and drives the next version.
3. The required checks must be green on an up-to-date branch: `ci` (typecheck,
   lint, unit, e2e), `image` (build once, attest), `integration` (that digest in
   the Docker lab, mock AI) and `pr-title`. Merge is **squash only**; no bypass.
4. On request, the owner may run the PR on stage before merging:
   `cortecho-deploy pr <N>`. One PR at a time on stage. After a merge or an
   abandoned PR, `cortecho-deploy main`.
5. On merge, `release.yml` re-tags the tested digest `:main` (no rebuild). For
   `feat` it releases a minor, `fix`/`perf` a patch, `!`/`BREAKING CHANGE` a
   major (minor while 0.x); `docs`/`test`/`ci`/`chore`/`refactor`/`build` publish
   nothing but still move `:main`. A release tags `:X.Y.Z`, `:X.Y`, `:latest`,
   creates the `vX.Y.Z` git tag and publishes a GitHub Release with the PR's
   evidence from the same digest. Never push a `v*` tag by hand. A fork PR was
   never pushed to ghcr, so it cannot be released; re-open it from a branch of
   this repository.

`:latest` means the newest release, not the newest merge. Pin `:X.Y.Z` or a
digest for a production install (see [deployment](deployment.md#image-tags)).

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
