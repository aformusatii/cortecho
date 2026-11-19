import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A destructive tool asks for a spoken yes (the confirm-by-voice barrier).
// Regression for 6d0f415: it must ask exactly once, then act on "yes", and the
// side effect (an email) must happen exactly once. The tool name depends on the
// configured mail connector; the example uses `send_email`.
describe('a destructive tool asks for a spoken yes', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('asks once, then acts on "yes"', async () => {
    const subject = `smoke test ${echo.runId} passed`;
    const ask = await echo.wake(`Send an email to myself saying ${subject}`);
    expect(ask.listensAgain).toBe(true); // INTENT_END continue_conversation=1
    expect(ask).toHaveSaidOnce(/should I|shall I|sure/i); // the transcribed reply audio

    const done = await echo.answer('Yes'); // spoken into the follow-up run
    expect(done.listensAgain).toBe(false);
    expect(done.said ?? '').not.toMatch(/should I|are you sure|confirm/i);
    expect(done.turn?.toolCalls.map((call) => call.name)).toContain('send_email');
    expect(done.wire).toEndWith(['tts_end', 'run_end']);

    // Exactly one message: the double-action class of bug. Skipped (reported,
    // not failed) until SMOKE_MAIL_* is configured.
    const mails = await echo.cleanup.mail.find(echo.runId);
    if (!mails.skipped) {
      expect(mails.value).toHaveLength(1);
      await echo.cleanup.mail.trash(mails.value);
    }
  });
});
