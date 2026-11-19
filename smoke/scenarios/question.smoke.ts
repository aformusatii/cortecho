import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
    expect(turn.said).toBeTruthy();
    expect(turn.said).toHaveSaidOnce(/\b\d{1,2}[:.]\d{2}\b/); // the time, said once (not twice)
    expect(turn.listensAgain).toBe(false);
    expect(turn.wire).toEndWith(['tts_end', 'run_end']);
    expect(turn.errorSound).toBe(false);
  });
});
