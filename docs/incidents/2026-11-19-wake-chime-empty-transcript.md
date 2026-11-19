# 2026-11-19 — the Echo said nothing: the wake chime made STT return an empty transcript

Investigation note. Two requests in a row were captured, transcribed to `""`
and ended quietly. The microphone and the VAD were fine; the Echo's own wake
chime at the start of the clip made `gpt-transcribe` return no text at all.
Keep this for the next time the Echo "ignores" a request that is not in the
history as `no-speech` with `nothing usable recognised`.

## Symptom

Turns **184** and **185** (3rd and 4th rows in the history, local 22:26:33 and
22:26:40) ended `no-speech`. The user spoke, the Echo went dark instead of
answering, and the next two attempts at 22:27 worked:

| Turn | Local | Outcome | Captured | Log |
|---|---|---|---|---|
| 187 | 22:27:26 | answered | 3.42 s | `heard: "What's the time?"` |
| 186 | 22:27:06 | answered | 2.88 s | `heard: "What is the time?"` |
| **185** | **22:26:40** | **no-speech** | 3.42 s | `nothing usable recognised {"text":""}` |
| **184** | **22:26:33** | **no-speech** | 2.28 s | `nothing usable recognised {"text":""}` |

The VAD did its job: `vad-silence-after-speech` with `speechHeard: true`, and
the debug WAVs in `data/audio/` hold the request. There was no error and no
warning — `stt-no-text-recognized` ends a run without the error sound by
design, so the Echo simply stopped.

## Root cause — the Echo's wake chime is uploaded to STT

Every wake run starts with hassmic's **800 ms of digital silence** (lead-in)
and then the Echo's own **~650 ms wake chime**. `liveStart` is the first
non-silent frame, i.e. the chime attack. The old pipeline sent the clip from
byte 0, so the chime was always the first thing the transcriber heard.

Causal test on the saved clips (same bytes, same model and key):

```
185 original                      -> ""                     (10/10 runs)
185 with 0.75-1.5 s zeroed        -> "What's the time?"     ✅
184 original                      -> "" / correct, flaky
184 with 0.75-1.5 s zeroed        -> "What was it then?"    ✅
186/187 with the same window zeroed -> still correct (no speech removed)
whisper-1 on 185                  -> "What's he done?"      (non-empty, wrong)
gpt-4o-transcribe on 185          -> "What'svitane?"        (non-empty, wrong)
```

`gpt-transcribe` returns HTTP 200 with `{"text":"","languages":[]}` when it
rejects the clip: it decided the audio was not speech. The chime alone is
usually tolerated (turns 186/187 worked with it); it is a borderline case, and
a quieter request (185) tips it over. The model is also not deterministic run
to run on the borderline clip (184).

Two pipeline gaps turned that into silence:

1. **No retry.** An empty transcript was final:
   `if (!isUsableTranscript(text)) { log.info('nothing usable recognised'); endQuietly(turn); }`.
2. **An empty *eager* transcript was reused.** `stt.eagerSilenceMs` starts a
   transcription during the closing pause; `transcribe()` returned its result
   even when it was `""`, so the final transcription never happened.

This is why switching to `gpt-4o-transcribe` is not a fix: it is older, 33%
more expensive, deprecated (shutdown 2027-02-26) and on these clips it invents
text instead of hearing none. `gpt-transcribe` is the better model; the input
was wrong.

## What changed

- `packages/shared/src/settings.registry.ts`: two new settings.
  - **`stt.wakeSoundSkipMs`** (default **650**, 0–3000 ms): how much audio to
    drop from the start of the **recovery** retry. The Echo's stock chime is
    650 ms. `0` disables this retry (the same-clip retry still runs).
  - **`stt.retryOnEmpty`** (default **on**): retry the same clip once, then
    once without the wake chime.
  Both apply from the next turn; no restart.
- `apps/api/src/pipeline/voice-pipeline.ts`:
  - `retryTranscription()` runs only when the VAD heard speech and the text has
    no letter or digit: at most two extra calls (same clip, then chime-trimmed).
  - `sttStartMs()` computes the recovery start (`liveStart` + the setting) and
    refuses to skip past `speechEndAtMs` (a chime-only turn keeps its audio).
  - `trimmedAudio({ skipWakeSound: true })` produces the recovery clip; the
    first upload and `transcribeEarly()` are unchanged.
  - `transcribe()` no longer returns an empty eager result as final.
  - `nothing usable recognised` is now a `warn` line and includes the model.
  - `DEBUG_AUDIO_DIR` writes a `-retry-no-wake-sound` WAV when the recovery ran.
- Tests (`apps/api/src/pipeline/voice-pipeline.test.ts`): a synthetic wake run
  (800 ms zeros + 650 ms chime + quiet request) recovers when the chime makes
  the fake model return `""`; the same clip is retried first; a chime clip that
  transcribes keeps its original upload; `retryOnEmpty: false` ends quietly
  after one call; `wakeSoundSkipMs: 0` retries without a trim.

### Why the trim is the recovery, not the first attempt

Trimming the chime before every upload was tried first and rejected on this
same evidence. The two failures behave differently when cut at the same place:

| Clip | Original upload | Cut at ~liveStart + 650 ms |
|---|---|---|
| 185 (failed 10/10) | `""` | **"What's the time?"** ✅ |
| 184 (failed ~1/5) | **"What's the time?"** (most runs) | "What was it?" / "What is it?" (consistently wrong) |

So trimming up front would have fixed the silent drop by turning a normally
correct request into a consistently misheard one. Keeping the untrimmed upload
first preserves accuracy and still gives every failing request a recovery path.

## Side effects and how to back out

- **The recovery may mishear rather than stay silent.** On a clip the model
  cannot read, the chime-trimmed retry can return a short wrong phrase (184
  above: "What was it?"). That is a deliberate trade: an answer the user can
  correct beats an Echo that ignores the request. Tune or disable it with
  `stt.wakeSoundSkipMs` (0) if a device prefers silence to a wrong guess.
- **Two extra STT calls** (about $0.00015 at current pricing) and a few seconds,
  only on a request that was about to fail. `stt.retryOnEmpty` turns this off.
- **Normal turns are unchanged**: the first upload still contains the chime, and
  the early/follow-up transcriptions are untouched.
- **Rollback:** set `stt.retryOnEmpty = false` (or `stt.wakeSoundSkipMs = 0`);
  no migration and no other code depends on the new keys.

## How to check it next time

1. `docker logs cortecho --since 1h | grep -E 'nothing usable|heard:|ending microphone'`.
2. The turn's row: `no-speech` + `nothing usable recognised` means STT, not the
   VAD. `ending microphone capture` with `speechHeard: true` confirms audio was
   captured.
3. `data/audio/utterance-*.wav` is the exact clip (the trim is applied). If the
   first ~0.75 s after the lead-in is loud and tonal, it is the chime.
4. Re-run the clip against the model (the same upload path) before assuming the
   model is broken; a different result on identical bytes means flakiness, and
   zeroing the chime segment is the quickest way to prove the cause.
