import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// "<wake word>, stop" ends the run quietly: the transcript is a stop word, so
// the Echo cancels (start=false alone) and nothing plays (spec §7.1, F11).
describe('the stop word', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('cancels the run quietly', async () => {
    const turn = await echo.wake(`${echo.env.SMOKE_ECHO_WAKE_WORD}, stop`);
    expect(turn.aborted).toBe(true);
    expect(turn.errorSound).toBe(false);
    expect(turn.said).toBeNull();
  });
});
