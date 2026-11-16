import type { Settings } from '@cortecho/shared';
import type { TextToSpeech } from './services.ts';

/**
 * Speaking an answer before it is fully written: the first sentence goes to
 * TTS as soon as the model has written it, the rest follows as a second TTS
 * request when the answer is complete. Both become one audio stream.
 *
 * Two requests at most: every extra request is a place where the voice's
 * melody restarts, and the gain is in the first one.
 */

/** A shorter first piece would play out before the rest's audio arrives. */
const MIN_HEAD_CHARS = 24;

/**
 * The first sentence of `textSoFar`, once the model has started the next one
 * (a sentence end followed by white space), or null. An answer of a single
 * sentence never has one: it is spoken whole when it is complete.
 */
export function firstSentence(textSoFar: string): string | null {
  const text = textSoFar.trimStart();
  const end = /[.!?…]["'”’»)\]]*(?=\s)/gu;
  for (let match = end.exec(text); match; match = end.exec(text)) {
    const length = match.index + match[0].length;
    if (length >= MIN_HEAD_CHARS) return text.slice(0, length);
  }
  return null;
}

/**
 * The audio of `head`, then of the text `rest` resolves to ('' = nothing
 * more). The rest is requested the moment its text is known, not when the
 * head's audio has ended, so there is no gap between the two.
 */
export async function* headThenRest(
  tts: TextToSpeech,
  head: string,
  rest: Promise<string>,
  signal: AbortSignal,
  settings: Settings,
): AsyncGenerator<Buffer> {
  const restAudio = rest.then((text) => (text ? buffered(tts.synthesize(text, signal, settings)) : null));
  // A failure is reported where the audio is read, below.
  restAudio.catch(() => {});
  yield* tts.synthesize(head, signal, settings);
  const more = await restAudio;
  if (more) yield* more;
}

/** Starts reading `source` at once and hands its items out in order, whenever they are asked for. */
function buffered<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  const items: T[] = [];
  const state: { done: boolean; failure: { error: unknown } | null; wake: (() => void) | null } = {
    done: false,
    failure: null,
    wake: null,
  };
  void (async () => {
    try {
      for await (const item of source) {
        items.push(item);
        state.wake?.();
      }
    } catch (error) {
      state.failure = { error };
    } finally {
      state.done = true;
      state.wake?.();
    }
  })();
  return (async function* () {
    for (let index = 0; ; ) {
      while (index < items.length) yield items[index++] as T;
      if (state.done) {
        if (state.failure) throw state.failure.error;
        return;
      }
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
    }
  })();
}
