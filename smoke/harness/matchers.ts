import { beforeEach, expect, onTestFinished } from 'vitest';
import { currentSmokeEcho } from './smoke-echo.ts';

// Spec §8: pass/fail per scenario in report.md, under the steps it ran.
beforeEach(({ task }) => {
  currentSmokeEcho()?.report.heading(task.fullName);
  onTestFinished(({ task: finished }) => {
    const state = finished.result?.state;
    const error = finished.result?.errors?.[0]?.message?.split('\n')[0] ?? '';
    currentSmokeEcho()?.report.scenario(finished.name, state !== 'fail', state === 'fail' ? error : '');
  });
});

/**
 * Custom matchers for the smoke scenarios (spec §7.2): `toEndWith`,
 * `toContainLine` and `toHaveSaidOnce`. Loaded once by the smoke config's
 * `setupFiles`, so every scenario has them.
 */

/** A `said` transcript lives on a turn observation, or is passed as a string. */
function saidOf(received: unknown): string | null {
  if (typeof received === 'string') return received;
  if (received && typeof received === 'object' && 'said' in received) {
    return (received as { said: string | null }).said ?? null;
  }
  return null;
}

expect.extend({
  /**
   * Exactly one sentence of the transcribed reply matches `pattern` (the "said
   * it twice" bug). Sentences, not matches: "Say yes if you want me to" is one
   * question even when the pattern lists both phrasings.
   */
  toHaveSaidOnce(received: unknown, pattern: RegExp) {
    const said = saidOf(received);
    if (said === null) {
      return { pass: false, message: () => 'expected the reply to have been said, but nothing was played' };
    }
    const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    // Split after . ! ? followed by a space; times like "23:04" and decimals stay whole.
    const sentences = said.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== '');
    const count = sentences.filter((sentence) => single.test(sentence)).length;
    return {
      pass: count === 1,
      message: () => `expected one sentence of "${said}" to match ${pattern}, found ${count}`,
    };
  },

  /** The wire events end with the given event-type sequence. */
  toEndWith(received: string[], expected: string[]) {
    const tail = received.slice(-expected.length);
    const pass = tail.length === expected.length && tail.every((type, i) => type === expected[i]);
    return {
      pass,
      message: () => `expected ${JSON.stringify(received)} to end with ${JSON.stringify(expected)}`,
    };
  },

  /** One of the log lines matches the pattern. */
  toContainLine(received: string[], pattern: RegExp) {
    const pass = received.some((line) => pattern.test(line));
    return {
      pass,
      message: () => `expected a line matching ${pattern}, got ${received.length} line(s)`,
    };
  },
});

declare module 'vitest' {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toHaveSaidOnce(pattern: RegExp): void;
    toEndWith(expected: string[]): void;
    toContainLine(pattern: RegExp): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveSaidOnce(pattern: RegExp): void;
    toEndWith(expected: string[]): void;
    toContainLine(pattern: RegExp): void;
  }
}
