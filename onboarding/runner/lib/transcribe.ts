import { withRealWavLengths } from './wav.ts';

export type TranscribeOptions = {
  gatewayUrl: string;
  /** For tests: replace fetch. */
  fetchImpl?: typeof fetch;
  model?: string;
};

/**
 * Transcribes a reply WAV through the gateway's OpenAI endpoint. The reply is
 * streamed by Cortecho with placeholder RIFF/data sizes, which OpenAI rejects
 * as `unsupported_format`, so the header is rewritten first. The response body
 * is read exactly once: reading it for an error message and then again for JSON
 * throws "Body is unusable".
 */
export async function transcribeReply(
  wav: Buffer,
  { gatewayUrl, fetchImpl = fetch, model = 'gpt-4o-mini-transcribe' }: TranscribeOptions,
): Promise<string> {
  const form = new FormData();
  const fixed = withRealWavLengths(wav);
  form.append('file', new Blob([fixed], { type: 'audio/wav' }), 'reply.wav');
  form.append('model', model);

  const response = await fetchImpl(`${gatewayUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`transcription failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(body) as { text?: unknown };
  return typeof parsed.text === 'string' ? parsed.text : '';
}
