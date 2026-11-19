import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The Echo rebooting / Wi-Fi dropping mid-turn: Cortecho aborts the turn.
describe('the link drops mid-turn', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('aborts the turn', async () => {
    const run = echo.wake('Count to one hundred');
    await echo.idle(1500);
    echo.dropLink();
    const turn = await run;
    expect(turn.aborted).toBe(true);
  });
});
