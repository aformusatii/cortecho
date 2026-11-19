import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A question that the Echo follows up on, but nobody answers: a quiet end.
describe('a follow-up is silent', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('ends the follow-up quietly', async () => {
    const ask = await echo.wake('Would you like me to continue?');
    expect(ask.listensAgain).toBe(true);

    const done = await echo.stayQuiet();
    expect(done.turn?.outcome).toBe('no-speech');
    expect(done.errorSound).toBe(false);
  });
});
