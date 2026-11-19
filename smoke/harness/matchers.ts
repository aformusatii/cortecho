import { expect } from 'vitest';

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
  /** The transcribed reply said `pattern` exactly once (the "said it twice" bug). */
  toHaveSaidOnce(received: unknown, pattern: RegExp) {
    const said = saidOf(received);
    if (said === null) {
      return { pass: false, message: () => 'expected the reply to have been said, but nothing was played' };
    }
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );
    const count = said.match(global)?.length ?? 0;
    return {
      pass: count === 1,
      message: () => `expected "${said}" to match ${pattern} once, found ${count} time(s)`,
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
