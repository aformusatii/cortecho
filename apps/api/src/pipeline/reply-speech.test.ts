import { buildSettings, DEFAULT_SETTINGS } from '@cortecho/shared';
import { describe, expect, it } from 'vitest';
import { firstSentence, headThenRest } from './reply-speech.ts';
import type { TextToSpeech } from './services.ts';

const settings = buildSettings(DEFAULT_SETTINGS);

describe('firstSentence', () => {
  it('finds the first sentence once the next one has started', () => {
    expect(firstSentence('The sky looks blue because')).toBeNull();
    expect(firstSentence('The sky looks blue because of the air.')).toBeNull(); // may be the whole answer
    expect(firstSentence('The sky looks blue because of the air. It')).toBe(
      'The sky looks blue because of the air.',
    );
    expect(firstSentence('  "Is the light in the kitchen on?" she')).toBe(
      '"Is the light in the kitchen on?"',
    );
  });

  it('does not cut inside numbers and keeps a short opening with the next sentence', () => {
    expect(firstSentence('It is 21.5 degrees in the living room')).toBeNull();
    expect(firstSentence('Sure. The light in the hall is on. And')).toBe(
      'Sure. The light in the hall is on.',
    );
  });
});

describe('headThenRest', () => {
  const signal = new AbortController().signal;
  const collect = async (source: AsyncIterable<Buffer>) => {
    const parts: string[] = [];
    for await (const chunk of source) parts.push(chunk.toString());
    return parts;
  };

  it('speaks the head, then the rest, as one stream', async () => {
    const asked: string[] = [];
    const tts: TextToSpeech = {
      sampleRate: 24000,
      async *synthesize(text) {
        asked.push(text);
        yield Buffer.from(`<${text}>`);
        yield Buffer.from('.');
      },
    };
    expect(await collect(headThenRest(tts, 'One.', Promise.resolve('Two.'), signal, settings))).toEqual([
      '<One.>',
      '.',
      '<Two.>',
      '.',
    ]);
    expect(asked).toEqual(['One.', 'Two.']);
    expect(await collect(headThenRest(tts, 'Only.', Promise.resolve(''), signal, settings))).toEqual([
      '<Only.>',
      '.',
    ]);
  });

  it('requests the rest as soon as its text is known, before the head has been read', async () => {
    const asked: string[] = [];
    let releaseHead: () => void = () => {};
    const tts: TextToSpeech = {
      sampleRate: 24000,
      async *synthesize(text) {
        asked.push(text);
        if (text === 'Head.') await new Promise<void>((resolve) => (releaseHead = resolve));
        yield Buffer.from(text);
      },
    };
    const reading = collect(headThenRest(tts, 'Head.', Promise.resolve('Rest.'), signal, settings));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual(['Head.', 'Rest.']);
    releaseHead();
    expect(await reading).toEqual(['Head.', 'Rest.']);
  });

  it('fails when the rest cannot be spoken', async () => {
    const tts: TextToSpeech = {
      sampleRate: 24000,
      async *synthesize(text) {
        if (text === 'Rest.') throw new Error('tts down');
        yield Buffer.from(text);
      },
    };
    await expect(
      collect(headThenRest(tts, 'Head.', Promise.resolve('Rest.'), signal, settings)),
    ).rejects.toThrow('tts down');
  });
});
