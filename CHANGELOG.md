# Changelog

All notable changes to Cortecho are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
