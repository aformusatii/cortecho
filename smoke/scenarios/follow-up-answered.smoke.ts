import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A question that the Echo follows up on, then the spoken answer.
describe('a follow-up is answered', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('asks, listens again, and acts on the answer', async () => {
    const ask = await echo.wake('What would you like to know?');
    expect(ask.listensAgain).toBe(true);

    const done = await echo.answer('Tell me a joke');
    expect(done.listensAgain).toBe(false);
    expect(done.turn?.outcome).toBe('answered');
    expect(done.said).toBeTruthy();
  });
});
