import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The model listens again, nobody answers: the follow-up ends quietly (no error sound).
describe('a follow-up is silent', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('ends the follow-up quietly', async () => {
    const ask = await echo.wake('Ask me what my favourite colour is, and wait for my answer.');
    expect(ask.listensAgain).toBe(true);

    const done = await echo.stayQuiet();
    expect(done.turn?.outcome).toBe('no-speech');
    expect(done.errorSound).toBe(false);
    expect(done.said).toBeNull(); // nothing played
  });
});
