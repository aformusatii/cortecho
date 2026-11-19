# Changelog

All notable changes to Cortecho are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
