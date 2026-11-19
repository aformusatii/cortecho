import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The action button cancels a run in progress (start=false alone, F18).
describe('the action button cancels', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('cancels while thinking', async () => {
    const run = echo.wake('Count to one hundred');
    // Cancel shortly after the request: while Cortecho is still thinking.
    await echo.idle(1500);
    echo.pressButton();
    const turn = await run;
    expect(turn.aborted).toBe(true);
  });
});
