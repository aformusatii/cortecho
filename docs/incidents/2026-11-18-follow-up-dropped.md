# 2026-11-18 — follow-up closed before the answer; "yes" asked twice

Investigation note. Symptom, the log/DB evidence, the cause on both sides
(Cortecho and hassmic) and what changed. Keep it for the next time a
follow-up seems to ignore the user.

## Symptom

A confirm-by-voice action (draft an email with a cat photo) went like this:

1. The assistant asked **“Say yes and I’ll save it.”**
2. The user said “Yes.” The tool ran and **failed** (the attachment URL
   returned HTTP 403).
3. The assistant tried again with another URL, which needed a new
   confirmation, so it asked **“Say yes” a second time** — without saying that
   the first attempt had failed.
4. The second follow-up **closed the microphone after 1.27 s**, before the user
   could answer. Nothing was heard, the run ended quietly.

The user’s report: “it asked for yes twice, then the second time it did not
even wait for Yes.”

Times below are local (UTC+2); the container logs are UTC.

| Local time | Turn | What happened |
|---|---|---|
| 22:29:45 | 16 | `gmail__draft_gmail_message` pending; reply asks for a yes |
| 22:29:59 | 17 | Heard “Yes.”; `[confirm] … confirmed: runs now` |
| 22:30:03 | 17 | `tool … failed in 1562 ms` — Wikimedia URL: `status 403` |
| 22:30:07 | 17 | Retry with a new URL; `[confirm] … waits for a spoken yes … "nothing was pending (first call)"` |
| 22:30:14.467 | 18 | Follow-up run starts (8 000 ms requested) |
| 22:30:15.740 | 18 | `ending microphone capture` — `elapsedMs 1273`, `silenceMs 810`, `speechEndAtMs 1260` |
| 22:30:15.865 | 18 | `nothing usable recognised {"text":""}` → `turn no-speech (follow-up)` |

## Cause 1 — the follow-up ended on the Echo’s own wake sound

The Echo plays its **wake sound** as a follow-up opens the microphone. In
hassmic (`echo-dot-assist`, build `2eebb42`):

- `core_pipeline_finish()` (main.c) does `sound_request(SND_WAKE)` when
  `continue_conversation=1`, then `pipeline_start()` — “the wake sound plays,
  then it listens” (`docs/protocol.md` says the same).
- `pipeline_start()` sends **800 ms of digital silence** first (`lead_in()`,
  main.c) so the server VAD/STT has a lead-in. That lead-in is exactly zeros;
  it is not acoustic silence.
- hassmic’s own notes (`PLAN.md`, `earsup.h`): the stock `ui_wakesound` is
  **650 ms**, and the Echo’s echo canceller only takes ~15 dB off it. What is
  left in the mic stream is “as loud as a quiet talker” — loud enough to cross
  Cortecho’s default speech threshold (`vad.minSpeechDb` −50 dBFS). Removing it
  (`wake_sound_removal`) exists but is **off by default**.

So the follow-up looked like this to the VAD:

```
audio:   800 ms zeros (lead_in) | 650 ms wake-sound echo | room noise
VAD:     silence                | speech!               | 810 ms silence -> speech-ended
```

`endSilenceMs` is 800 ms, so the VAD closed the capture **1.27 s after the
microphone opened**, not after the 8 s it was told to wait. The 8 s
`noSpeechTimeoutMs` never applies, because the VAD believed the user had
already spoken.

This is why it was intermittent: the user must answer within about **0.8 s of
the wake sound ending** (~1.3 s after the prompt). A “Yes.” at ~1.0–1.4 s
merged with the wake sound and worked (turns 137, 141, 143, 146); a slower
answer did not (turns 125, 139, 147). “Keeps dropping” = the user was not fast
enough.

The VAD never heard the 800 ms of lead-in as speech (zeros are −96 dBFS), but
it also cannot tell the wake-sound echo from a real voice by energy alone.

### What changed (Cortecho)

- `apps/api/src/vad/end-of-speech.ts`: new `startGuardMs` option. The detector
  finds where the leading digital silence ends (`liveStartMs`) and does not
  let frames within `startGuardMs` of it start or continue speech. The frames
  stay in the audio timeline, so trimming/transcription is unchanged; STT still
  transcribes from the first byte, so an answer spoken over the fading sound is
  kept. The steady-noise re-judge also skips windows containing guard frames.
- `apps/api/src/pipeline/voice-pipeline.ts`: follow-ups get
  `startGuardMs` (`FOLLOW_UP_START_GUARD_MS`; 1000 after the second occurrence
  below), and the value is logged in
  `follow-up turn started`.
- Tests: `end-of-speech.test.ts` (wake sound alone is not an answer; without
  the guard it ends at ~1.3 s; an answer over the fading sound is heard),
  `voice-pipeline.test.ts` (a fake follow-up with 800 ms zeros + 650 ms sound
  is not transcribed), `followUpVad` expectations.

Silence is now the wanted behaviour: a silent follow-up waits its full
`wait_seconds` and then ends quietly. If the Echo’s wake sound is turned off,
the guard does nothing harmful (the first live frames are the room).

### Other options (not applied)

- Enable **“Wake sound removal (experimental)”** on the Echo (hassmic
  settings): removes our own sound from the mic stream. It is experimental and
  holds audio ~0.65 s.
- Turn the wake sound off on the Echo: no sound, no echo, but the user loses
  the “I’m listening” cue.

Both are device settings and need the owner’s OK.

## Cause 2 — a failed tool was retried silently and asked for a second yes

- The confirmed call ran and failed with
  `error: Error calling tool 'draft_gmail_message': … Failed to fetch attachment URL https://upload.wikimedia.org/… (status 403)`.
- The agent logged the failure only at `debug` (`agent.ts`), so the visible log
  just said `failed in 1562 ms`, and the status page only showed a grey
  “(failed)” pill.
- In the same turn the model retried the same tool with a different URL. The
  confirm barrier correctly saw different arguments as a new action, armed a
  new pending action, and the model asked for a yes **again** — presenting the
  retry as if nothing had failed.

### What changed

- `apps/api/src/tools/registry.ts`: a failed call records `errorDetail` (the
  stack, capped at 6 000 chars) with the result.
- `apps/api/src/pipeline/agent.ts`: failures are logged at `warn` with the
  tool’s message; the model gets `[the tool call failed: tell the user exactly
  what failed …]` appended to the tool output; and a tool that failed in a turn
  **cannot run again in that turn** — a same-turn retry returns
  `error: <tool> failed earlier in this turn and was not retried…` without
  calling the connector. The confirm gate therefore cannot arm a second “say
  yes” for the same action in that turn.
- `packages/shared/src/voice.schema.ts`: `ToolCallRecord.errorDetail`.
- `apps/web/src/features/status/components/TurnsList.tsx`: a failed tool call is
  **red**; clicking it opens the arguments, the error and the stack. Successful
  and pending calls open the same panel.
- `apps/api/src/pipeline/prompt-layers.ts`: rule “When a tool call fails, say
  what failed; never retry that tool in the same request.”
- Tests: `registry.test.ts` (stack recorded), `agent.test.ts` (retry refused,
  model told to report, handler ran once).

## Follow-up the same evening — the model asked for a yes without listening

After the deploy, turn 149 armed a pending draft and said **“If you say yes,
I’ll save it as a Gmail draft…”** — no question mark and no
`listen_for_reply`. `followUp.mode` is `tool`, and the question-mark fallback
(enabled at 20:57, settings v7) only covers a reply ending in “?”, so the Echo
closed the mic again. Model compliance cannot be the only guarantee for a
confirmation.

Now a turn that **arms a pending confirm action** keeps the microphone open by
itself: the agent adds `listen` with the usual wait (the model’s
`listen_for_reply` wins when present), unless `followUp.mode` is `never`. The
reply carries `continue_conversation=1`, so the Echo plays its wake sound and
listens — with the wake-sound guard from the first fix. Covered in
`agent.test.ts` (pending yes → `listen: { waitMs: 8000 }`; `never` → no
listen) and noted in [connectors](../connectors.md#confirm-by-voice-honestly).

## Second occurrence — the guard was 100 ms too short (turn 151)

The first fix used `startGuardMs = 650`, the stock sound's own length. The next
follow-up still ended early:

```
[pipeline] follow-up turn started … {"noSpeechTimeoutMs":8000,…,"startGuardMs":650}
[pipeline] ending microphone capture {"reason":"vad-silence-after-speech",
  "elapsedMs":1574,"audioMs":2370,"followUp":true,"speechHeard":true,
  "silenceMs":810,"speechEndAtMs":1560,"noiseFloorDb":-65.0}
```

Read the positions: `audioMs − elapsedMs ≈ 800` is the lead-in, so the live
audio was 1 574 ms and the “speech” ended at **764 ms into it**. The guard
covered 650 ms; the remaining 114 ms was the wake sound's **echo tail** (the
650 ms sound plus the room), enough for five 30 ms frames — exactly
`minSpeechMs` — so it counted as an answer and 810 ms of silence ended the run
at 1.57 s.

The successful follow-ups in the same period had real answers ending
1 270–1 600 ms into the live audio, so the guard was raised to **1000 ms**:
covers the measured tail with ~240 ms margin and still leaves a normal answer.
`agent.test.ts`/`end-of-speech.test.ts` now model a 760 ms sound (test: a
650 ms guard leaves the tail as speech; 1000 ms does not).

`DEBUG_AUDIO_DIR=/app/data/audio` is now set on the deployment: **every
follow-up's raw audio** (lead-in, wake sound, answer) is written as a WAV, so
the next oddity can be measured rather than inferred. Remove it when done (it
records the user's voice). `DEBUG_AUDIO_KEEP=40` keeps the newest 40.

## Third iteration — a 2 s deaf VAD plus an STT check of the opening

Owner requirement: “when the Echo starts listening, ALL audio immediately
captured; the VAD not triggered for the first 2 seconds.” The guard was
raised to **2000 ms**.

Capturing was already complete: `turn.audio` keeps every byte from hassmic's
lead-in on, and STT is given the audio from byte 0. What the guard changes is
only whether the **VAD** may end the turn. A blind 2 s guard alone would have
made the VAD deaf to an early answer, so the pipeline now checks that window:

- The detector records `lastLoudAtMs` (loudest/last frame at or above the
  speech threshold, guard included) without counting guard frames as speech.
- `checkOpening` (voice-pipeline.ts) waits until the guard is over **and** the
  audio has been quiet for `endSilenceMs` (800 ms). If the last loud frame is
  past `liveStart + 900 ms` — the Echo's 650 ms sound plus its ~760 ms echo
  tail — it transcribes the opening up to that point and:
  - usable text → the turn runs with it (`reason: vad-wake-sound-check`);
  - nothing (only the Echo's sound) → the VAD keeps listening for a later
    answer, and the normal wait applies.
- If the wait expires while that check is still transcribing, the end is held
  until it answers (`pendingNoSpeech`), so a slow STT cannot lose it.

Cost: an answer given **inside** the 2 s window is processed after the guard
plus 800 ms of silence (~3 s) instead of ~1.5 s — the price of a deaf first
2 s. An answer after the guard is immediate. A follow-up with no answer does
one small STT call on the opening only when it contained audio past the
Echo's own sound.

Tests: `end-of-speech.test.ts` (loud audio in the guard is recorded but not
speech; an answer after the guard is heard) and `voice-pipeline.test.ts`
(a "yes" at ~1 s inside the guard is transcribed and answered, even when the
wait expires while the check runs).

## How to investigate the next one

Container logs (UTC; local is UTC+2 in winter):

```bash
docker logs cortecho --since 2h 2>&1 \
  | grep -vE 'GET /api/(health|turns|reply-audio|devices|settings|status)' \
  | grep -E '\[pipeline\]|\[agent\]|\[confirm\]'
```

A dropped follow-up looks like this:

```
[pipeline] follow-up turn started  … "vad": {"noSpeechTimeoutMs":8000,…,"startGuardMs":650}
[pipeline] ending microphone capture {"reason":"vad-silence-after-speech",
  "elapsedMs":1273,"audioMs":2070,"followUp":true,"speechHeard":true,
  "silenceMs":810,"speechEndAtMs":1260,"noiseFloorDb":-77.3}
```

Read it as: `elapsedMs` = wall clock since the run started; `audioMs` =
frames received (the 800 ms lead-in is included, so `audioMs − elapsedMs ≈
800`); `speechEndAtMs` = audio position of the last speech frame. If that is
around 800 + 650 = 1 450 ms and `speechEndAtMs` is ~1 300, the VAD probably
heard the wake sound. With the guard it should not happen; if it does, capture
the audio (below) before changing anything.

The turn rows (tool calls, timings, outcome) live in `data/app.db`:

```bash
python - <<'PY'
import sqlite3, json
db = sqlite3.connect('data/app.db'); db.row_factory = sqlite3.Row
for r in db.execute("select id,started_at,outcome,transcript,tool_calls,error,"
                    "timings from turns order by id desc limit 10"):
    print('---', r['id'], r['started_at'], r['outcome'])
    print('heard:', r['transcript'], '| error:', r['error'])
    print('tools:', r['tool_calls'])
    print('timings:', r['timings'])
PY
```

A failed tool call in the UI is red; open it for the connector’s message and
the stack. The same message is on the `[agent]` warn line.

To capture the actual mic audio next time, set `DEBUG_AUDIO_DIR=/app/data/audio`
(e.g. in the gitignored override) and restart; one WAV per utterance, newest
`DEBUG_AUDIO_KEEP` kept. Analyse with `sox … stat` / `ffmpeg` or listen to it.
The follow-up WAV should start with 800 ms of silence, then the wake sound, then
the user.

## Related

- Wake sound in the pipeline: `echo-dot-assist/PLAN.md` sections “Wake sound in
  the pipeline’s audio” and “Wake sound removal”; `src/hassmic/earsup.h`.
- Follow-up protocol: [../protocol.md](../protocol.md#follow-up-questions).
- Confirmations: [../connectors.md](../connectors.md#confirm-by-voice).
