import { describe, expect, it } from 'vitest';
import { ReplyAudio, ReplyAudioStore } from './reply-audio.ts';

/** A TTS stream the test feeds by hand. */
function handFed() {
  const queue: (Buffer | null)[] = [];
  let wake: (() => void) | null = null;
  const give = (item: Buffer | null) => {
    queue.push(item);
    wake?.();
  };
  async function* source(): AsyncGenerator<Buffer> {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = queue.shift();
      if (!item) return;
      yield item;
    }
  }
  return { source: source(), push: (ms: number) => give(Buffer.alloc(ms * 48)), end: () => give(null) };
}

const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return done;
};

describe('ReplyAudio.ready', () => {
  it('waits for the pre-buffer, not just for the first chunk', async () => {
    const tts = handFed();
    const reply = new ReplyAudio(tts.source, 24000);
    const atFirstChunk = reply.ready();
    const prebuffered = reply.ready(400);
    tts.push(200); // OpenAI's first burst
    expect(await settled(atFirstChunk)).toBe(true);
    expect(await settled(prebuffered)).toBe(false);
    tts.push(340);
    expect(await settled(prebuffered)).toBe(true);
    tts.end();
  });

  it('does not wait for more than a short reply has', async () => {
    const tts = handFed();
    const reply = new ReplyAudio(tts.source, 24000);
    tts.push(150);
    tts.end();
    await reply.ready(400);
    expect(reply.durationMs).toBe(150);
  });

  it('rejects when TTS ends without audio', async () => {
    const tts = handFed();
    const reply = new ReplyAudio(tts.source, 24000);
    tts.end();
    await expect(reply.ready(400)).rejects.toThrow('TTS returned no audio');
  });
});

describe('ReplyAudioStore', () => {
  it('serves two devices’ current replies at once and forgets a revoked one', async () => {
    const store = new ReplyAudioStore(60_000);
    const first = handFed();
    const second = handFed();
    const a = store.create(first.source, 24000);
    const b = store.create(second.source, 24000);
    expect(a.id).not.toBe(b.id);
    expect(store.get(a.id)).toBe(a);
    expect(store.get(b.id)).toBe(b);
    expect(store.size).toBe(2);

    store.revoke(a);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBe(b);
    first.end();
    second.end();
  });

  it('expires a reply after its TTL', async () => {
    const store = new ReplyAudioStore(1);
    const tts = handFed();
    const reply = store.create(tts.source, 24000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.get(reply.id)).toBeNull();
    tts.end();
  });
});
