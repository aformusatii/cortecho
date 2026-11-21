# How a turn works

Cortecho speaks the ESPHome native API, because that is what `hassmic` (from
[echo-dot-assist](https://github.com/Gamer92000/echo-dot-assist)) exposes on the
Echo. The Echo is the server; Cortecho is its voice assistant client. The
implementation follows hassmic's `proto_esphome.c` and Home Assistant's
ESPHome assist satellite.

## The exchange

| # | Direction | Message | Notes |
|---|---|---|---|
| 0 | app → Echo | Noise handshake (NNpsk0, the API key), `HelloRequest`, `ConnectRequest`, `DeviceInfoRequest`, `SubscribeVoiceAssistantRequest{subscribe, API_AUDIO}` | After every (re)connect. hassmic logs `voice assistant: subscribed` |
| – | app → Echo | `PingRequest` every 10 s | Nothing from the Echo for 25 s → reconnect (1 s doubling to 30 s) |
| – | Echo → app | `GetTimeRequest` | After our first ping once hassmic has started, then every 6 h. We answer `GetTimeResponse{epoch, POSIX TZ rule}`. **Only over the keyed link** does hassmic set its clock and zone from it |
| 1 | Echo → app | `VoiceAssistantRequest{start, wake_word_phrase}` | Wake word, action button, or a follow-up |
| 2 | app → Echo | `VoiceAssistantResponse{port:0}`, `RUN_START`, `STT_START` | Ring → listening |
| 3 | Echo → app | `VoiceAssistantAudio` × n | 16 kHz s16le mono, 4 KiB pieces, gain-controlled by hassmic. It streams until we end listening (or sends `end=true` itself when its experimental `end_of_request` setting is on; off by default) |
| 4 | app | VAD | Our VAD does what Home Assistant's does: speech then 800 ms of silence ends the request; no speech for 8 s, or 15 s in total, too. The noise floor adapts, also to room noise that hassmic's gain lifted above -50 dBFS |
| 4b | app → Echo | `STT_VAD_END` | Mic off, ring → thinking |
| 5 | app → Echo | `STT_END{text}`, `INTENT_START` | After transcription, which already started 300 ms into the closing pause (see [performance](performance.md)). Nothing usable → `ERROR{code:"stt-no-text-recognized"}` + `RUN_END`: quiet end |
| 6 | app | agent, then TTS | Responses API with tools, streamed; TTS starts on the first sentence while the agent writes the rest. The whole answer and the first audio are awaited |
| 7 | app → Echo | `INTENT_END{continue_conversation}`, `TTS_START{text}`, `TTS_END{url}`, `RUN_END` | `url` = the **Reply address** (`network.replyBaseUrl`, Settings → Network) + `/api/reply-audio/<random id>.wav` |
| 8 | Echo → app | `GET <url>` | A WAV (24 kHz) that streams while speech is still generated |
| 9 | Echo → app | `VoiceAssistantAnnounceFinished` | hassmic plays replies like announcements: playback is over, the turn ends |
| 10 | Echo → app | `VoiceAssistantRequest{start}` again | Only after `continue_conversation=1`: the wake sound plays, then it listens without the wake word |

## Rules that keep the Echo from hanging

The Echo gives up on its own after more than **30 s in one state**
(listening or thinking; hassmic's `PIPELINE_TIMEOUT`), so the app must finish
each state well inside that, and it must always end the turn itself:

- every turn ends with `RUN_END` (after the reply) or `ERROR` + `RUN_END`;
- any failure before the reply is handed over → a short **spoken apology**;
  if even that fails → `ERROR{code:"pipeline-error"}` (the Echo plays its
  error sound);
- `VoiceAssistantRequest{start:false}` (action button, "Computer, stop") is an
  abort: the turn is dropped and nothing more is sent for it;
- no reply handed over within the turn deadline (24 s) after the end of speech
  → abort + apology (listening itself is bounded by the VAD's 15 s);
- the link drops mid-turn → the turn is aborted and recorded.

## Several Echos

Each Echo is its own ESPHome server, and hassmic gives the voice assistant to
its **first** subscriber only. Cortecho therefore opens **exactly one link per
Echo**, subscribes after every connect, and never opens the same `host:port`
twice. Never run a second client (a dev server, Home Assistant) next to the
deployed instance while a device is enabled.

The Echoes also need to be paired with each other, or every Echo that hears
the wake word answers. Pairing is done on the devices, not in Cortecho. The
device's own status page (`http://<echo-ip>:28931`) must show it as a member of
the network.

## Follow-up questions

`followUp.mode` (default `tool`): the model decides. It is offered a built-in
tool, `listen_for_reply({wait_seconds, question?})`, and the instructions
explain the Echo's interaction model (the ring goes off after a reply unless
it calls the tool). When it calls it, `INTENT_END` carries
`continue_conversation=1`. After playing the answer the Echo plays its wake
sound and starts a new run without the wake word, and the VAD waits
`wait_seconds` (clamped to the configured shortest/longest wait) for the answer
to start. If nobody answers, the run ends quietly.

The tool costs no extra model round trip. A response with the reply text and
the call together is the final answer; if the model calls it without writing
text, its `question` argument is spoken instead. Modes: `tool`; `question`
(the old heuristic: listen when the answer ends with "?"); `always`; and
`never`.

## Storage

Each turn is stored in SQLite (newest 1000) with transcript, reply, tool calls,
Echo and timings: speech end → transcript → reply → audio ready → played, in ms
from the Echo's request. Audio is never stored unless `DEBUG_AUDIO_DIR` is set.
