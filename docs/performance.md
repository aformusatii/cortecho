# Speed

What the user waits for is the time from the end of their speech to the first
audio. It is made of the VAD's closing silence (800 ms), then transcription,
agent and TTS in a row. What keeps it short:

- **Transcription starts in the closing pause**, 300 ms after the speech
  stopped (`stt.eagerSilenceMs`), not when the VAD ends the request at 800 ms.
  When the user goes on speaking the result is ignored and a later pause starts
  a new one.
- **The connection to OpenAI is opened at the wake word.** A cold connection
  costs about 200 ms and an idle one is closed after 15 to 30 s.
- **The agent gets the date and time with every request**, so "what time is
  it" is one model request, not two with a tool call between them.
- **TTS starts on the answer's first sentence** while the agent writes the
  rest; the rest is a second TTS request in the same WAV. The reply is still
  handed to the Echo only when the whole answer is known: `INTENT_END` says
  whether a follow-up comes, and text written before a tool call is not the
  answer.
- **Tool calls of one round run at the same time.**
- **Connector calls are bounded twice:** the connector's own timeout (default
  10 s, max 20 s) and the turn deadline minus 3 s. Connections are warm before
  the wake word; a tool call never opens one.

Measured with the fake Echo and the real OpenAI APIs on 2026-11-13, nine turns
each, three questions, from the end of speech to the first audio:

| | before | after |
|---|---|---|
| average | 3.5 s | 2.7 s |
| "What time is it?" | 4.2 s | 2.4 s |
| transcription, after the VAD's end | 0.7 s | 0.2 s |
| agent, without a tool call | 0.7–1.5 s | 0.8–1.9 s (unchanged: the model) |
| connector call (a warm MCP session) | — | 0.1–0.5 s + the model's next round |
| TTS, first audio after a long answer | 0.5–0.8 s | 0.2–0.3 s |

What is left is mostly the closing silence and the model's time to its first
word (about 1 s, the same with reasoning effort `none`). A Realtime API mode is
the step that removes both; it is on the roadmap.

Your own numbers are on the status page: each turn shows speech end →
transcript → reply → audio ready → played.
