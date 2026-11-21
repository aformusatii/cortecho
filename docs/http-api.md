# HTTP API

Base URL: `http://<docker-host>:3000`. The SPA is served at `/`, `/echos`,
`/echos/:id`, `/setup` and `/settings`.

## Status and turns

| Method | Path | What |
|---|---|---|
| `GET` | `/health`, `/api/health` | JSON: `devices` (each Echo's live state), `settingsVersion`, uptime, tools, last turn. Always 200 while the app runs |
| `GET` | `/api/turns?limit=20&deviceId=` | Latest turns (1–100), with `deviceId`/`deviceName`/`settingsVersion`; optional Echo filter |
| `GET` | `/api/reply-audio/<id>.wav` | **For the Echo:** the current reply or announcement as WAV, by its random id, until it expires or the turn ends. Anything else is 404 |

## Voice

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/ask` | `{text, deviceId?}` — runs the agent on text. With `deviceId`, that Echo's memory, prompt and settings; without, the `web` session and global settings |
| `POST` | `/api/conversation/reset` | Drops the `web` session's memory (the counterpart of the per-Echo reset above). 204 |
| `POST` | `/api/say` | `{text, deviceId? \| all?, voice?}` — announces text. Neither field = every enabled Echo; `deviceId` = that one; `all` excludes disabled and test devices. Returns `{results: [{deviceId, deviceName, ok, turn?, error?}]}` |

`deviceId` is a number (the Echo's id). An unknown id is 404. `/api/say` with
`voice {voice, speed, instructions}` previews unsaved form values.

Examples:

```bash
curl -s http://192.168.1.10:3000/api/say \
  -H 'Content-Type: application/json' \
  -d '{"text":"Dinner is ready."}'

curl -s http://192.168.1.10:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"text":"What is on my calendar?","deviceId":1}'
```

## Setup wizard and discovery

The UI's first launch and the Add Echo flow (spec §5, §7). Nothing here returns
a device key: a key in a request body is written or checked, never echoed.

| Method | Path | What |
|---|---|---|
| `GET` | `/api/setup` | `{onboardingDone, hasEcho, hasOpenAiKey, replyBaseUrl, homeConfirmed}` |
| `POST` | `/api/setup/complete` | Records `onboarding.completedAt` and returns the document. Called by the wizard, and when the first Echo is adopted |
| `DELETE` | `/api/setup/complete` | "Run the first-time setup again": clears `onboarding.completedAt` and returns the document |
| `POST` | `/api/setup/check-openai` | `{apiKey?}` → `{ok:true}` or `{ok:false, code:"rejected"\|"unreachable"}`. Absent key = check the stored one; the key is never echoed |
| `GET` | `/api/discovery` | `{scanning, lastScanAt, found: DiscoveredEcho[]}`; memory only, rebuilt after a restart |
| `POST` | `/api/discovery/scan` | `{hints?: string[]}` (the UI sends `location.hostname`) → 202 with the document. At most once per 60 s; a call inside that window returns the running/last scan |
| `POST` | `/api/discovery/ignore` | `{mac}` (12 hex or colon-separated) → 204 |
| `DELETE` | `/api/discovery/ignore/:mac` | 204 |
| `POST` | `/api/devices/probe` | `{host, port?, apiKey?}` → `{reachable, isVoiceAssistant, nodeName, mac, friendlyName, model, keyState:"none"\|"set"\|"matches"}` or `{reachable:false, code:"unreachable"\|"not-esphome"\|"timeout"}`. Connects, says Hello and asks DeviceInfo, then closes; never subscribes |
| `POST` | `/api/devices/adopt` | `{host, port?, name?, kind?, apiKey?}` → 201 `DeviceStatus`. Connects, generates a key, stores it before sending it and secures an Echo that has none; `apiKey` is used only for an Echo another app already secured. Errors: `ECHO_UNREACHABLE` (502), `NOT_AN_ECHO` (409), `ECHO_KEY_SET` (409), `ECHO_KEY_INVALID` (409), `ALREADY_ADDED` (409), `ADOPT_FAILED` (502), `CONFLICT` when an adoption of the same address is already running |
| `POST` | `/api/devices/:id/secure` | "Secure now" for an existing unkeyed row; same key step, 409 `ECHO_KEY_SET` when it already has one |

A `DiscoveredEcho` has `mac`, `host`, `port`, `nodeName`, `friendlyName`,
`model`, `keyState` (`none`/`set`), `source` (`mdns`/`scan`/`both`),
`lastSeenAt`, `addedAs` (matched by MAC first, then `host:port`), `movedFrom`
(the same MAC seen at a new address while the device is disconnected) and
`ignored`. A discovery result never contains a key.

## Devices

| Method | Path | What |
|---|---|---|
| `GET` | `/api/devices` | `DeviceStatus[]` (never a key, only `hasKey`) |
| `POST` | `/api/devices` | `{name, kind?, host, port?, apiKey?, enabled?, prompt?}` → 201; 409 on a duplicate name or `host:port` |
| `PATCH` | `/api/devices/:id` | Any field; `apiKey: null` clears it, absent keeps it. Restarts the link only when host/port/key/enabled changed |
| `DELETE` | `/api/devices/:id` | Stops the link; turns keep their history with `deviceId` null |
| `POST` | `/api/devices/:id/reconnect` | Drops and reopens the link |
| `POST` | `/api/devices/:id/conversation/reset` | Drops that Echo's conversation memory (and any pending confirm). 204; idempotent; 404 for an unknown device |
| `POST` | `/api/devices/:id/accept-device` | Stores the node name the Echo now reports after `unexpected-device` |
| `POST` | `/api/devices/:id/test-sound` | Plays the bundled chime through the reply-audio path (no OpenAI call) and waits up to 8 s: `{downloaded, finished, url}`. 409 while the Echo is in a turn or not connected |
| `GET` | `/api/devices/:id/settings` | `{version, overrides, effective}` |
| `PATCH` | `/api/devices/:id/settings` | `{version, changes}`; only per-Echo keys; `null` = inherit |
| `GET` | `/api/devices/:id/instructions` | The exact prompt layers the next request sends |

Hosts must be private LAN or loopback (`10/8`, `172.16/12`, `192.168/16`,
`127/8`). Public addresses, link-local, multicast, `0.0.0.0` and IPv6 are
rejected.

## Connectors (MCP servers)

Secrets are write-only: responses carry `hasHeaders` and `hasClientSecret`,
never a value. Write routes (`POST`/`PATCH`/`DELETE`) refuse a browser request
whose `Origin` is not this app (`MCP_ALLOWED_ORIGINS` adds origins); requests
without an `Origin`, such as curl, are allowed.

| Method | Path | What |
|---|---|---|
| `GET` | `/api/mcp/catalog` | The Add dialog's catalog entries and whether `CORTECHO_SECRET_KEY` is set |
| `GET` | `/api/mcp/servers` | Connectors with runtime state, auth state and tool counts |
| `POST` | `/api/mcp/servers` | Create from `{name, slug, url, transport?, authType, headers?, oauthConfig?, clientSecret?, timeoutMs?, maxResultChars?, description?, enabled?}` |
| `GET` | `/api/mcp/servers/:id` | One connector plus every tool and its policy |
| `PATCH` | `/api/mcp/servers/:id` | Any create field. Changing the URL or OAuth client deletes the stored credentials |
| `DELETE` | `/api/mcp/servers/:id` | Close the connection, revoke OAuth when supported, delete rows |
| `POST` | `/api/mcp/servers/:id/reconnect` | Restart the link |
| `POST` | `/api/mcp/servers/:id/oauth/start` | Begin a flow; `{authorizationUrl}` opens in a new tab |
| `GET` | `/api/mcp/oauth/callback?code&state&iss` | Browser redirect target; validates state and issuer, then `302` to `/settings?tab=connectors&server=<id>&auth=ok` |
| `POST` | `/api/mcp/oauth/complete` | `{callbackUrl}` manual fallback for a localhost redirect |
| `POST` | `/api/mcp/servers/:id/oauth/disconnect` | Revoke when possible and delete the account |
| `POST` | `/api/mcp/servers/:id/tools/refresh` | Re-run `tools/list` now |
| `PATCH` | `/api/mcp/servers/:id/tools` | `{policies: {tool: "off"\|"auto"\|"confirm"}}`; approves the current definition |
| `POST` | `/api/mcp/servers/:id/tools/:name/try` | `{arguments, confirm?}` runs one tool from the UI; write tools need `confirm: true` |
| `GET` | `/api/mcp/oauth/client-metadata.json` | The CIMD document, when `MCP_CIMD_ENABLED=true` |

`GET /api/health` also has `connectors: [{slug, state, authState}]`. See
[connectors.md](connectors.md) for the policy and OAuth rules.

## Settings

| Method | Path | What |
|---|---|---|
| `GET` | `/api/settings` | `{version, stored, effective, hasKeys}`; secrets are never returned |
| `PATCH` | `/api/settings` | `{version, changes}`; 409 when the version is stale |
| `GET` | `/api/settings/changes?limit=&scope=` | Change history |
| `POST` | `/api/settings/changes/:id/revert` | Revert one change |
| `GET` | `/api/settings/instructions` | The assembled prompt layers |
| `GET` | `/api/openai/models` | Model ids for the pickers (empty on failure) |
| `GET` | `/api/doctor` | Read-only diagnostics (same checks as `cortecho doctor`) |

## Errors

Errors use one shape:

```json
{ "error": { "code": "ECHO_UNAVAILABLE", "message": "…", "fields": {} } }
```

Codes include `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`,
`ECHO_UNAVAILABLE`, `ECHO_BUSY`, `UPSTREAM_ERROR`, and the setup wizard's
`ECHO_UNREACHABLE`, `NOT_AN_ECHO`, `ECHO_KEY_SET`, `ECHO_KEY_INVALID`,
`ALREADY_ADDED`, `ADOPT_FAILED`.
