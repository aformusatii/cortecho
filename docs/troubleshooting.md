# Troubleshooting

Start with `cortecho doctor` (also `npm run doctor`). It checks the settings,
the secrets, the Echo link, the reply address and the OpenAI endpoint, and
prints the fix for each failure. The same checks are on the status page.

Then look at the app log (`docker compose logs -f app`) and, on the Echo,
`/data/local/hassmic/boot.log`. Useful lines per turn: `[pipeline] heard:` and
`reply:`, `[pipeline] ending microphone capture` (VAD reason and audio
positions), `[agent] tool <name> ok|failed|pending … {"turn","round"}`, with a
`warn` line carrying a failed tool's message, `[agent] turn N: an action waits
for a spoken yes`, and `[confirm]` for the confirm-by-voice barrier.
`LOG_LEVEL=debug` adds the tool names of every model round.

| Symptom | Cause / fix |
|---|---|
| Status "Connecting…", log `connect … ECONNREFUSED` | hassmic is not in ESPHome mode (`grep PROTO /data/local/hassmic/hassmic.conf`) or not running |
| `the Echo refused plaintext: an API key is set on it` | The Echo has a key but this device has none (`encryption-required`), or Home Assistant adopted the Echo. Use the **Fix** action: paste the Echo's key in the "already secured" step (or under **Connection → Advanced**) |
| `handshake refused: Handshake MAC failure` (`invalid-key`) | The stored key is not the one on the Echo (it was removed or changed there, or another app set one). Use **Fix** to paste the right key, or remove the key on the Echo and add it again (see [securing the Echo](echo-setup.md#the-api-key)) |
| `ECHO_API_KEY is set but the Echo answered in plaintext` (`key-not-set`) | hassmic speaks plaintext only here; check its version, or clear the device's key |
| Both Echos answer the same wake word | The Echos are not paired: hold Volume up + Volume down for 2 s on each (see [Echo setup](echo-setup.md#several-echos)) |
| `duplicate-node-name` on two cards | Both have the same `NAME` in `hassmic.conf`; hassmic's network needs unique names |
| `unexpected-device` on a card | The address now reports another node name; use **Accept new device** if that is expected |
| Connected, but the wake word does nothing | Another client subscribed to the voice assistant first (`boot.log`: `a second client tried to subscribe, ignored`). Stop the other client (a dev server, Home Assistant) and reconnect the device |
| The Echo keeps listening long after you stopped | The VAD did not hear the end: a noisy room close to your voice level. Check the noise floor with `DEBUG_AUDIO_DIR`; raise the speech margin or silence threshold in **Settings → Listening**, or turn on hassmic's experimental end-of-request detection |
| Problem `reply-address-missing`, or turn stops after "thinking", Echo plays nothing, log `no playback report` | The Echo cannot download the reply: set this computer's LAN address under **Settings → Network** (the **Reply address**), and check `boot.log` `media: http://… ->`. Use **Play a test sound** to verify the download. In Docker the container's own address is not reachable, so the reply address is required |
| A new Echo is not on the Discovered card | Discovery missed it: use **Setup → Enter an address instead** (it never depends on discovery), or **Search again**. mDNS needs host networking; the subnet scan does not. An ignored Echo stays hidden until **Show ignored → Stop ignoring** |
| Clock still 2010 / "Clock sent: –" | The Echo has no key, so the link is plaintext (`boot.log`: `clock: … not set …`), or hassmic has not asked yet (it asks after its start and every 6 h) |
| A setting changed in `cortecho.env` does nothing | Behaviour settings are imported only on a fresh database. Change them in the UI (see [configuration](configuration.md)) |
| Follow-up never comes | The model did not call `listen_for_reply` (see the turn's tool calls in the UI), or the answer did not end with "?" in `question` mode; the Echo's wake sound may also be off (the follow-up still listens) |
| Follow-up closes before you answer | Fixed 2026-11-18: the Echo's wake sound (and its echo tail) was counted as speech, then 800 ms of room silence ended the run. A follow-up now has a **2 s VAD guard**; an answer inside it is found by an STT check of the opening (`[pipeline] follow-up: checking the opening audio`, `reason: vad-wake-sound-check`) and answers after it are the VAD's. Check `[pipeline] ending microphone capture`: `audioMs − elapsedMs ≈ 800` is hassmic's lead-in. If it returns, see [the incident note](incidents/2026-11-18-follow-up-dropped.md); `DEBUG_AUDIO_DIR` keeps each follow-up's WAV in `data/audio/` |
| You spoke, the Echo said nothing, history says `no-speech` | Fixed 2026-11-19: the Echo's ~650 ms wake chime is uploaded before your words and `gpt-transcribe` sometimes returns an empty string for that clip. An empty transcript is now retried as-is, then once without the chime (`stt.wakeSoundSkipMs`, default 650 ms; `stt.retryOnEmpty` off disables it). A `warn` line `nothing usable recognised` means it still failed; `data/audio/` has the exact clip (look for a `-retry-no-wake-sound` one when the trimmed retry ran). See [the incident note](incidents/2026-11-19-wake-chime-empty-transcript.md) |
| A tool failed and the assistant carried on as if nothing happened | Fixed 2026-11-18: the failure is now a `warn` log line, a red tool call in the status page (click it for the error and stack), and a tool that fails cannot be retried in the same turn — the model must report it |
| The Echo reads out `<tool_call>{…}` | No longer spoken: the model wrote a tool call as text. The log shows `[agent] model wrote … as text`; a `listen_for_reply` written this way still keeps the microphone open, any other is dropped (not run). If it keeps happening, try another model |
| Asked to confirm the same action twice | See the `[confirm]` log lines and [connectors troubleshooting](connectors.md#troubleshooting) |
| `Provider key missing` on the status page | The key for a provider a stage uses is not stored. Add it in **Setup → Connect OpenAI** (or under **Settings → Providers**) |
| Search answers are cut off | Raise **Maximum answer length**: reasoning and search queries share the token budget |
