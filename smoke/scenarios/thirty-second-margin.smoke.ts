import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The 30 s margin (spec §12, F20): hassmic gives up after 30 s in one
// LISTENING/THINKING state. A follow-up answer that starts late and runs long
// must be cut before that (Cortecho caps follow-up listening at 27 s) and still
// answered. This is a margin test, not a regression: production settings are
// unchanged, only the Test Echo's per-Echo follow-up wait is raised.
describe('the 30 s margin', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());
  afterEach(() => echo.restoreMirrored());

  test('a late, long follow-up answer is still answered before the Echo gives up', async () => {
    // Give the follow-up a long wait so a late answer is still accepted.
    await echo.setDeviceSetting({ 'followUp.maxWaitMs': 20_000 });
    const ask = await echo.wake('Let me know when you are ready, and I will continue.');
    expect(ask.listensAgain).toBe(true);

    // Start the answer late — inside hassmic's 30 s, past the default wait.
    await echo.idle(3000);
    const done = await echo.answer('Yes, I am ready now.');
    expect(done.turn?.outcome).toBe('answered');
    expect(done.timedOut).toBe(false);
  });
});
