# HTTP API

Base URL: `http://<docker-host>:3000`. The SPA is served at `/`, `/echos`,
`/echos/:id` and `/settings`.

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

## Devices

| Method | Path | What |
|---|---|---|
| `GET` | `/api/devices` | `DeviceStatus[]` (never a key, only `hasKey`) |
| `POST` | `/api/devices` | `{name, kind?, host, port?, apiKey?, enabled?, prompt?}` → 201; 409 on a duplicate name or `host:port` |
| `PATCH` | `/api/devices/:id` | Any field; `apiKey: null` clears it, absent keeps it. Restarts the link only when host/port/key/enabled changed |
| `DELETE` | `/api/devices/:id` | Stops the link; turns keep their history with `deviceId` null |
| `POST` | `/api/devices/:id/reconnect` | Drops and reopens the link |
| `POST` | `/api/devices/:id/accept-device` | Stores the node name the Echo now reports after `unexpected-device` |
| `GET` | `/api/devices/:id/settings` | `{version, overrides, effective}` |
| `PATCH` | `/api/devices/:id/settings` | `{version, changes}`; only per-Echo keys; `null` = inherit |
| `GET` | `/api/devices/:id/instructions` | The exact prompt layers the next request sends |

Hosts must be private LAN or loopback (`10/8`, `172.16/12`, `192.168/16`,
`127/8`). Public addresses, link-local, multicast, `0.0.0.0` and IPv6 are
rejected.

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
`ECHO_UNAVAILABLE`, `ECHO_BUSY`, `UPSTREAM_ERROR`.
