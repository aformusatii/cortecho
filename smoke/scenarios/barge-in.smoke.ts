import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SPOKEN_TIME } from '../harness/matchers.ts';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The wake word during a reply (hassmic main.c, local wake while SPEAKING):
// the reply is cut, the wake sound plays, and a new run takes the request.
describe('barge-in during a reply', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('cuts the reply and answers the new request', async () => {
    const story = echo.wake('Tell me a story about a lighthouse keeper, about one minute long.');
    const second = await echo.bargeIn('What time is it?', { afterMs: 2000 });
    const first = await story;
    expect(first.turn?.outcome).toBe('answered'); // the story's turn was handed over before the cut
    expect(second.echoLog).toContain('barge-in');
    expect(second.turn?.transcript ?? '').toMatch(/time/i);
    expect(second.turn?.outcome).toBe('answered');
    expect(second.said).toHaveSaidOnce(SPOKEN_TIME);
    expect(second.turn?.reply ?? '').toMatch(SPOKEN_TIME);
    expect(second.errorSound).toBe(false);
  });
});
