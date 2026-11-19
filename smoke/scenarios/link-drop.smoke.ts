import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The Echo rebooting or its Wi-Fi dropping while the agent thinks: Cortecho
// aborts the turn, reconnects on its own, and the next turn works.
describe('the link drops mid-turn', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('aborts the turn, and the Echo is answered after the reconnect', async () => {
    const run = echo.wake('Count slowly from one to twenty.');
    await echo.dropLink({ during: 'thinking' });
    const dropped = await run;
    expect(dropped.turn?.outcome).toBe('aborted');

    await echo.newConversation(); // waits for the reconnect
    const after = await echo.wake('What time is it?');
    expect(after.turn?.outcome).toBe('answered');
  });
});
