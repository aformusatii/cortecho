# Configuration

Cortecho has three layers, plus connectors. Know which one you are changing,
because they are read at different times.

| Layer | Where it lives | How to change it | When it applies |
|---|---|---|---|
| **Settings** (behaviour) | SQLite (`data/app.db`), per Echo overrides in `devices.overrides` | Web UI under **Settings** and **Echos → Tuning**, or `GET/PATCH /api/settings` and `GET/PATCH /api/devices/:id/settings` | From the next turn (link timings from the next connect) |
| **Echoes** | SQLite (`devices`) | Web UI under **Echos** | Immediately (the link restarts when host, port, key or enabled changes) |
| **Connectors** | SQLite (`mcp_servers`, `mcp_credentials`, `mcp_tools`) | Web UI under **Settings → Connectors** and the Echo's **Connectors** tab | Immediately; a new tool is offered on the next turn |
| **Environment** | Process environment (`cortecho.env`, compose, shell) | Edit the file and restart the container | At every start |

> **The most common mistake:** changing a behaviour value in `cortecho.env`
> after the first start does nothing. The first start imports those values into
> SQLite, then ignores them. The app warns at startup about variables that are
> now ignored. Change them in the UI instead.

## 1. Environment-only

These are read on every start and are deliberately not in the UI yet (the UI
has no authentication).

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `HOST` | `0.0.0.0` | Interface the HTTP server binds to |
| `PORT` | `3000` | HTTP port inside the container |
| `DATABASE_PATH` | `./data/app.db` | SQLite file (relative to the repository root) |
| `SYSTEM_PROMPT_FILE` | `./SystemPrompt.md` | Legacy household prompt imported once on a fresh database (relative to the repository root). Empty disables the import |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `REPLY_AUDIO_TTL_MS` | `120000` | How long a reply URL stays valid |
| `DISCOVERY_EXTRA_TARGETS` | *(none)* | Comma-separated `host:port` additions to the network scan (an Echo on another subnet, tests). The scan only connects to private IPv4 addresses |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible server (proxies, local models). The key and models stay in Settings; the server must implement the Responses API, streaming speech and audio transcription |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | ElevenLabs-compatible server (proxies, tests). The key and voice/model choices stay in Settings; the paths are the API's own (`/v1/…`, `/v2/…`) |
| `DEBUG_AUDIO_DIR` | *(unset)* | Save each utterance as a WAV (your voice!). Debug only |
| `DEBUG_AUDIO_KEEP` | `20` | Number of recordings kept |
| `TOOL_TIMEOUT_MS` | `8000` | Per-tool timeout |
| `TOOLS_ALLOW_DESTRUCTIVE` | *(none)* | Comma-separated names of destructive tools that may run |
| `TOOLS_ENABLE_ECHO` | `true` | Register the harmless `echo_test` tool |
| `HTTP_TOOL_ENDPOINTS` | `{}` | JSON: named endpoints for `http_request` |
| `HOME_ASSISTANT_URL` | *(unset)* | Home Assistant REST base URL |
| `HOME_ASSISTANT_TOKEN` | *(unset)* | Home Assistant long-lived token (secret) |
| `HOME_ASSISTANT_ALLOWED_SERVICES` | *(none)* | Services `home_assistant_call_service` may call |
| `SHELL_TOOL_SCRIPTS` | `{}` | JSON: named scripts for `run_script` (destructive) |
| `TOOLS_FILE` | *(unset)* | Path to a JSON file with `httpToolEndpoints` and `shellToolScripts`; an alternative to JSON inside an env var |
| `PUBLIC_BASE_URL` | *(empty)* | The URL the owner's **browser** uses for Cortecho (e.g. `https://echo-agent.example.com`). OAuth's redirect URI is `${PUBLIC_BASE_URL}/api/mcp/oauth/callback`; empty falls back to the request origin |
| `CORTECHO_SECRET_KEY` | *(unset)* | Base64 of 32 random bytes; encrypts connector headers, client secrets and OAuth tokens at rest (AES-256-GCM). Losing it means signing in to every connector again |
| `MCP_ALLOWED_ORIGINS` | *(none)* | Comma-separated extra browser origins allowed to call the connector write routes (CSRF guard; requests without `Origin`, such as curl, are allowed) |
| `MCP_CIMD_ENABLED` | `false` | Serve the Client ID Metadata Document at `/api/mcp/oauth/client-metadata.json` (needs a publicly reachable path) |

`HTTP_TOOL_ENDPOINTS` and `SHELL_TOOL_SCRIPTS` are JSON in an environment
variable, which is easy to break with quoting. `TOOLS_FILE` accepts a file
instead:

```json
{
  "httpToolEndpoints": {
    "weather": { "url": "http://192.168.1.10:8006/weather", "description": "Current outdoor weather" }
  },
  "shellToolScripts": {
    "backup_status": { "path": "/app/scripts/backup-status.sh", "description": "Last backup result" }
  }
}
```

## 2. Imported once, then stored in SQLite

On a **fresh database**, the first start imports the values below and
`SystemPrompt.md` into SQLite. Afterwards the database is the source of truth;
a warning at start lists any of these variables that are still set. Remove
them from `cortecho.env` after the first successful start.

- The Echo: `ECHO_HOST`, `ECHO_PORT`, `ECHO_API_KEY` create one device named
  "Echo". On a new install, add it in **Setup** (or from its **Discovered**
  card) instead: the wizard sets the key itself and nothing has to be edited.
  Later Echoes are added the same way; `echo-set-key` stays a CLI fallback and
  still reads these variables for its own command line.
- The provider keys (OpenAI, ElevenLabs) and every behaviour setting: see the
  table below (its **Env** column). `SystemPrompt.md` in the project root
  becomes the household prompt; `SYSTEM_PROMPT_FILE` can point elsewhere or be
  empty to skip it.
- `TZ` is special: it sets the container clock on every start **and** seeds
  `assistant.timeZone` once. Changing `TZ` later changes the container clock
  but not the assistant's time zone; change that in **Settings**.
- **Upgrading an older install:** `REPLY_AUDIO_BASE_URL` used to be read at
  every start. On the first start after the upgrade it is copied once into
  `network.replyBaseUrl` (only if that setting was never saved), then it is
  ignored like the variables above. An invalid value is not copied; the
  warning at start and **Settings → Network** point at it.

## 3. Settings (SQLite)

The registry in `packages/shared/src/settings.registry.ts` is the contract: it
defines validation, defaults and the generated UI. Every key can be overridden
per Echo when the **Per Echo** column says yes.

**Connectors are a fourth kind of state.** The MCP server rows, their OAuth
credentials and their tool policies live in SQLite next to these settings but
are *not* part of the versioned settings document: each connector saves on its
own, because OAuth and tool syncs are runtime operations. See
[connectors.md](connectors.md). `connectors.enabled` and
`connectors.confirmWindowS` are ordinary settings; `connectors.disabled` is the
per-Echo list edited on the Echo's **Connectors** tab (hidden from Tuning).

| Key | Label | Default | Env (import only) | Per Echo |
|---|---|---|---|---|
| `assistant.householdPrompt` | Household prompt | (empty) | — | no |
| `assistant.locale` | Locale | `en-US` | `AGENT_LOCALE` | no |
| `assistant.timeZone` | Time zone | `UTC` | `TZ` | no |
| `assistant.sessionIdleMinutes` | Conversation idle time | `5` | `SESSION_IDLE_MINUTES` | no |
| `assistant.apologyText` | Apology | `Sorry, something went wrong. Please try again.` | `APOLOGY_TEXT` | no |
| `stt.provider` | Speech-to-text provider | `openai` | — | no |
| `stt.model` | Speech-to-text model | `gpt-transcribe` | `STT_MODEL` | no |
| `stt.elevenlabsModel` | ElevenLabs transcription model | `scribe_v3` | — | no |
| `stt.languages` | Languages | (auto) | `STT_LANGUAGES` | yes |
| `stt.prompt` | Recognition hints | (empty) | `STT_PROMPT` | yes |
| `stt.wakeSoundSkipMs` | Skip the Echo's wake sound when retrying | `650` | `STT_WAKE_SOUND_SKIP_MS` | no |
| `stt.retryOnEmpty` | Retry an empty transcript | `true` | `STT_RETRY_ON_EMPTY` | no |
| `stt.eagerSilenceMs` | Start transcribing early | `300` | `STT_EAGER_SILENCE_MS` | no |
| `agent.model` | Model | `gpt-5.4-mini` | `AGENT_MODEL` | no |
| `agent.reasoningEffort` | Reasoning effort | `low` | `AGENT_REASONING_EFFORT` | no |
| `agent.webSearch` | Web search | `true` | `AGENT_WEB_SEARCH_ENABLED` | no |
| `agent.maxOutputTokens` | Maximum answer length | `2000` | `AGENT_MAX_OUTPUT_TOKENS` | no |
| `agent.maxToolRounds` | Maximum tool rounds | `4` | `AGENT_MAX_TOOL_ROUNDS` | no |
| `connectors.enabled` | Connected services | `true` | — | no |
| `connectors.disabled` | Disabled connectors | `[]` | — | yes |
| `connectors.confirmWindowS` | Confirmation window | `60` | — | no |
| `tts.provider` | Text-to-speech provider | `openai` | — | no |
| `tts.model` | Text-to-speech model | `gpt-4o-mini-tts` | `TTS_MODEL` | no |
| `tts.voice` | Voice | `marin` | `TTS_VOICE` | yes |
| `tts.elevenlabsModel` | ElevenLabs model | `eleven_flash_v2_5` | — | no |
| `tts.elevenlabsVoiceId` | ElevenLabs voice | `JBFqnCBsd6RMkjVDRZzb` | — | yes |
| `tts.elevenlabsStability` | ElevenLabs stability | `0.5` | — | no |
| `tts.speed` | Speed | `1` | `TTS_SPEED` | yes |
| `tts.instructions` | Voice instructions | `Speak clearly, warmly and at a natural pace.` | `TTS_INSTRUCTIONS` | yes |
| `tts.outputRate` | Output sample rate | `0` | `TTS_OUTPUT_RATE` | no |
| `followUp.mode` | Follow-up | `tool` | `FOLLOW_UP_MODE` | yes |
| `followUp.questionMarkFallback` | Listen after a question mark | `false` | `FOLLOW_UP_QUESTION_MARK_FALLBACK` | no |
| `followUp.minWaitMs` | Shortest wait | `4000` | `FOLLOW_UP_MIN_WAIT_MS` | no |
| `followUp.maxWaitMs` | Longest wait | `20000` | `FOLLOW_UP_MAX_WAIT_MS` | yes |
| `vad.minSpeechDb` | Silence threshold | `-50` | `VAD_MIN_SPEECH_DB` | yes |
| `vad.speechMarginDb` | Margin above noise | `12` | `VAD_SPEECH_MARGIN_DB` | yes |
| `vad.minSpeechMs` | Shortest speech | `150` | `VAD_MIN_SPEECH_MS` | no |
| `vad.endSilenceMs` | End silence | `800` | `VAD_END_SILENCE_MS` | yes |
| `vad.noSpeechTimeoutMs` | Wait for speech | `8000` | `VAD_NO_SPEECH_TIMEOUT_MS` | yes |
| `vad.maxUtteranceMs` | Longest request | `15000` | `VAD_MAX_UTTERANCE_MS` | no |
| `reply.prebufferMs` | Reply pre-buffer | `400` | `REPLY_PREBUFFER_MS` | yes |
| `pipeline.turnDeadlineMs` | Turn deadline | `24000` | `TURN_DEADLINE_MS` | no |
| `network.replyBaseUrl` | Reply address | (empty) | `REPLY_AUDIO_BASE_URL` | no |
| `openai.timeoutMs` | OpenAI timeout | `20000` | `OPENAI_TIMEOUT_MS` | no |
| `openai.apiKey` | OpenAI API key | (none) | `OPENAI_API_KEY` | no |
| `elevenlabs.timeoutMs` | ElevenLabs timeout | `20000` | — | no |
| `elevenlabs.apiKey` | ElevenLabs API key | (none) | — | no |
| `echo.duplicateWakeWindowMs` | Duplicate wake window | `2000` | — | no |
| `echo.reconnectMinMs` | Reconnect delay (min) | `1000` | `ECHO_RECONNECT_MIN_MS` | no |
| `echo.reconnectMaxMs` | Reconnect delay (max) | `30000` | `ECHO_RECONNECT_MAX_MS` | no |
| `echo.pingIntervalMs` | Ping interval | `10000` | `ECHO_PING_INTERVAL_MS` | no |
| `echo.pingTimeoutMs` | Ping timeout | `25000` | `ECHO_PING_TIMEOUT_MS` | no |
| `echo.playedGraceMs` | Playback grace | `8000` | `ECHO_PLAYED_GRACE_MS` | no |

Details that matter:

- **Providers.** Understanding and Voice each choose their own provider
  (`stt.provider`, `tts.provider`): OpenAI or ElevenLabs, in any combination.
  Thinking always uses OpenAI. Both provider keys live in **Settings →
  Providers**, are write-only, and are only needed when a stage selects them
  (the OpenAI key is always needed for thinking).
- **Conditional fields.** Switching a stage's provider shows only that
  provider's fields; the hidden values are kept, not cleared, so switching back
  restores them. A save sends every changed key, visible or not.
- **Listen here.** Next to the voice field, **Listen here** synthesizes the
  draft voice with the selected provider and plays a WAV in this browser (no
  Echo, no save). **Play on an Echo** does the same through an Echo. The
  per-voice samples in the ElevenLabs picker come from the server-side voice
  list (account or default voices) and are proxied by
  `/api/settings/elevenlabs-voices/:id/preview`.
- **ElevenLabs key permissions.** Text to speech and speech to text need only
  the key itself. The optional voice and model lists need **Voices → Read** and
  **Models → Read**; a key without them still works for speech and is reported
  as valid by **Test key**. Without **Voices → Read**, the picker offers
  ElevenLabs' default voices; your own and cloned voices still need that
  permission, or you can paste their id.
- **Secrets are write-only.** `GET /api/settings` returns `hasKeys`, never the
  OpenAI or ElevenLabs key; `GET /api/devices` returns `hasKey`, never the Echo
  key. Both live plaintext in SQLite: the database file is the crown jewel.
  Back it up privately.
- **The household prompt** is the first instruction layer. The built-in answer
  rules and the search policy are code-owned. **Show the full prompt** displays
  the assembled layers. For a first start, copy `SystemPrompt.example.md` to
  `SystemPrompt.md`; it is imported once and then ignored.
- **Per-Echo overrides** are tri-state: off means *inherit*, not a copy. The
  row shows the inherited global value.
- **One version counter** covers global and per-Echo changes. A form carries
  the version it loaded; a save from another tab gets `409` and offers to
  reapply.
- **`tts.speed`** is shared. OpenAI accepts the whole range; ElevenLabs accepts
  0.7 to 1.2, so values outside that are clamped for an ElevenLabs voice.
- **`tts.model`** defaults to `gpt-4o-mini-tts`, which OpenAI shuts down on
  **2027-01-06**. Set a supported speech model before then, or set the voice
  provider to ElevenLabs, or use the Realtime API work on the roadmap.
- **ElevenLabs voice ids** can be picked by name from the account's voices, or
  from ElevenLabs' default voices when the key cannot list the account (with a
  browser sample), or pasted; `JBFqnCBsd6RMkjVDRZzb` is the premade "George".
- **`network.replyBaseUrl`** is how the Echos reach this app on the LAN
  (`http://192.168.1.10:3000`). It is empty on purpose in development, where
  the link's local address is used. In Docker set it once under
  **Settings → Network**: the Echo downloads every answer from it, so a
  container-internal address plays nothing. A public URL is refused.

## 4. Docker variables

`docker-compose.yml` uses `APP_PORT` for the published port and `DATA_DIR` for
the bind-mounted SQLite directory. Compose reads these from `.env` (or the
shell), **not** from `env_file`, so keep them in `.env` if you change them.
