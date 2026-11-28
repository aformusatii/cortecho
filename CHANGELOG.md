# Changelog

All notable changes to Cortecho are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

> **Releases are now generated on merge.** The GitHub Release is the record:
> `release.yml` derives the version from the PR title and publishes generated
> notes with the test evidence. This file is the hand-written history up to
> that change; do not add a section per release by hand.

## [Unreleased]

### Fixed

- **The Echo no longer ignores a request because of its own wake chime.**
  Every wake run uploads hassmic's 800 ms lead-in and the Echo's ~650 ms wake
  chime before the user's words; `gpt-transcribe` can return an empty string for
  such a clip, and the turn then ended quietly (`nothing usable recognised`).
  An empty transcript is now retried once as-is, then once without the Echo's
  wake chime (`stt.wakeSoundSkipMs`, default 650 ms, `0` = off,
  `stt.retryOnEmpty` = on/off), and an empty *eager* transcript is no longer
  reused as final. The first upload is unchanged. See
  [the incident note](docs/incidents/2026-11-19-wake-chime-empty-transcript.md).
- **Follow-ups no longer end on the Echo's wake sound.** hassmic plays its
  650 ms wake sound as a follow-up opens the mic; the VAD counted the echo as
  speech and closed the capture after 800 ms of silence (~1.3 s in) instead of
  waiting the requested time. The VAD is now deaf for the first **2 s** of a
  follow-up, while all audio is still captured from the first byte; loud audio
  past the sound's measured ~760 ms echo tail, once quiet, is transcribed by
  STT (`reason: vad-wake-sound-check`), so an answer given inside those 2 s is
  heard too. Answers after the guard are the VAD's as usual.
  See [the incident note](docs/incidents/2026-11-18-follow-up-dropped.md).
- **A pending spoken yes always keeps the microphone open.** Even when the
  model asks for it in a sentence without a question mark and forgets
  `listen_for_reply` (as in “If you say yes, I’ll save it.”), the reply now
  carries `continue_conversation` — unless `followUp.mode` is `never`.
- **Tool failures are visible and are not retried silently.** A failed call
  logs its message at `warn`, is red and openable (arguments, error, stack) on
  the status page, and cannot be called again in the same turn: the model gets
  the connector's error and must tell the user. A confirmed action that fails
  can no longer arm a second “say yes” in that turn.

### Added

- **Setup wizard: add an Echo from the UI, like Home Assistant.** Cortecho
  discovers Echos on the network (mDNS, and a subnet scan that works on
  Compose's default bridge), secures the link with a key it generates and
  never shows, plays a sound so the owner can identify the device, and asks
  which room it is in. A permanent **Setup** item in the nav, **Discovered**
  cards on the Echos page, a first-launch onboarding (home, OpenAI, first
  Echo), a "not set up yet" banner and **Fix** links on device problems.
  Adding the first Echo finishes onboarding; the CLI `echo-set-key` stays a
  fallback.
- **`network.replyBaseUrl` ("Reply address")** is a setting under
  **Settings → Network**, with a **Play a test sound** button. An existing
  deployment copies `REPLY_AUDIO_BASE_URL` into it once, on the first start
  after the upgrade. Production no longer refuses to start without it: the
  affected Echo shows `reply-address-missing` and the wizard fixes it.
- `DISCOVERY_EXTRA_TARGETS` for Echos on another subnet (and tests).
- Echos learn their MAC address from `DeviceInfo`; discovery uses it as the
  identity, so a changed DHCP address offers "Use the new address" instead of
  looking like a new device.
- New routes: `POST /api/devices/probe`, `POST /api/devices/adopt`,
  `POST /api/devices/:id/secure`, `POST /api/devices/:id/test-sound`,
  `GET/POST/DELETE /api/discovery*` and `GET/POST/DELETE /api/setup*`.
- New tables `app_state` (onboarding) and `discovery_ignored` (ignored
  Echos), and a nullable unique `devices.mac`.
- **MCP connectors**: connect Gmail, Google Calendar, Home Assistant or any MCP
  server in Settings → Connectors. Streamable HTTP with an SSE fallback, header
  auth and OAuth 2.1 (PKCE, discovery, pre-registered clients, DCR), encrypted
  connector secrets, per-tool Off / Automatic / Confirm-by-voice policies with a
  cross-turn confirmation barrier, definition pinning, per-Echo limits, health
  and doctor checks.
- Settings tabs (`?tab=general|connectors`), an Echo **Connectors** tab, and
  connector labels on the turn history.
- `CORTECHO_SECRET_KEY`, `PUBLIC_BASE_URL`, `MCP_ALLOWED_ORIGINS` and
  `MCP_CIMD_ENABLED`; `docs/connectors.md`.
- Logger redaction for tokens, OAuth codes and secret-named fields.

### Changed

- **No environment file needs editing on a new install.**
  `docker compose up -d` works with the compose file as downloaded, and the
  setup wizard sets the Echo, the OpenAI key and the reply address in the UI.
  `ECHO_*`, `OPENAI_API_KEY` and `REPLY_AUDIO_BASE_URL` moved from
  `cortecho.env.example` to a commented **"Upgrading an older install"** block
  (still imported once); `DISCOVERY_EXTRA_TARGETS` is documented there and in
  [configuration](docs/configuration.md).
- The Echos page no longer lists CLI steps or asks for an address, port and
  key in an Add dialog: an Echo is added through the wizard, and the
  Connection tab's key field is under **Advanced** ("Paste a key only if this
  Echo was secured by another app"). **Remove key** is now **Forget the key in
  Cortecho** (the Echo keeps its key).

## [0.1.0] - 2026-11-16

First public release.

### Added

- ESPHome native API client for a rooted Echo running echo-dot-assist
  (`hassmic`), with plaintext and Noise-encrypted links.
- Speech-to-text → LLM agent with tools → text-to-speech pipeline, streamed
  into a WAV the Echo downloads and plays.
- Several Echos from one instance, each with its own prompt, memory and
  room-dependent settings.
- Settings in SQLite, edited in the web UI, with per-Echo overrides, a version
  counter, history and revert; one-time import from the environment.
- Follow-up questions without the wake word (the model decides when to listen).
- Announcements over HTTP (`/api/say`), text questions (`/api/ask`), turn
  history and timings.
- Tools: web search, Home Assistant REST, named HTTP endpoints, named scripts,
  a harmless echo test.
- Fake Echo and two FakeEchos for E2E tests; the whole suite runs without
  hardware, an OpenAI key or the internet.
- `cortecho doctor`, a read-only configuration/link check, and its
  `GET /api/doctor` endpoint.
- One-file Docker install with a published image, plus a source-build compose
  file.
