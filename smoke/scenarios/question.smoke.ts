import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { expectEnglish, expectHeard, SPOKEN_TIME } from '../harness/matchers.ts';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A plain question: the Echo answers, plays the reply once, and does not listen again.
describe('a plain question', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('answers and hands the reply over once', async () => {
    const turn = await echo.wake('What time is it?');
    expect(turn.turn?.outcome).toBe('answered');
    expectHeard(turn.serverLog, /what time is it/i);
    expectEnglish(turn.turn?.reply);
    expect(turn.said).toBeTruthy();
    expect(turn.said).toHaveSaidOnce(SPOKEN_TIME); // the time, said once (not twice)
    expect(turn.turn?.reply ?? '').toMatch(SPOKEN_TIME); // and the reply text names it too
    expect(turn.listensAgain).toBe(false);
    expect(turn.wire).toEndWith(['tts_end', 'run_end']);
    expect(turn.errorSound).toBe(false);
  });
});
