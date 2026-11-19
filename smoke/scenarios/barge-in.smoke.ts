import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// The wake word during a reply cuts the playback and starts a new run (barge-in).
describe('barge-in during a reply', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('cuts the reply and starts a new run', async () => {
    // A long reply so the barge-in has something to cut.
    const first = echo.wake('Tell me a long story');
    await echo.idle(1500);
    const second = await echo.bargeIn('What time is it?', { afterMs: 0 });
    expect(second.turn?.outcome).toBe('answered');
    expect(second.said).toBeTruthy();
    // The first run was cut.
    const firstTurn = await first;
    expect(firstTurn.aborted).toBe(true);
  });
});
