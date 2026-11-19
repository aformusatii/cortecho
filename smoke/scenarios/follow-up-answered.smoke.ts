import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The model asks a question and listens again (listen_for_reply); the answer
// spoken into the follow-up run is understood without the wake word.
describe('a follow-up is answered', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('asks, listens again, and acts on the answer', async () => {
    const ask = await echo.wake('Ask me what my favourite colour is, and wait for my answer.');
    expect(ask.listensAgain).toBe(true);
    expect(ask.said ?? '').toMatch(/colou?r/i);

    const done = await echo.answer('Blue.');
    expect(done.turn?.transcript ?? '').toMatch(/blue/i);
    expect(done.turn?.outcome).toBe('answered');
    expect(done.said ?? '').toMatch(/blue/i);
    expect(done.errorSound).toBe(false);
  });
});
