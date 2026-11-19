import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A destructive tool asks for a spoken yes (the confirm-by-voice barrier).
// Regression for 6d0f415: it must ask exactly once, then act on "yes", and the
// side effect (an email) must happen exactly once. The tool name depends on the
// configured mail connector (send or draft), so it is matched loosely.
/** The model's wording varies ("Say yes and I'll save it", 'Say "yes" to save it', "Shall I send it?"). */
const CONFIRM_QUESTION = /say\W+yes|should I|shall I|are you sure|do you want|want me to/i;

describe('a destructive tool asks for a spoken yes', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('asks once, then acts on "yes"', async () => {
    const subject = `smoke test ${echo.tag} passed`;
    const ask = await echo.wake(`Send an email to myself saying ${subject}`);
    expect(ask.listensAgain).toBe(true); // INTENT_END continue_conversation=1
    // The confirmation question, asked once (the wording is the model's).
    expect(ask).toHaveSaidOnce(CONFIRM_QUESTION);

    const done = await echo.answer('Yes'); // spoken into the follow-up run
    expect(done.listensAgain).toBe(false);
    expect(done.said ?? '').not.toMatch(CONFIRM_QUESTION); // not asked again
    expect(done.turn?.toolCalls.map((call) => call.name).join(' ')).toMatch(/mail|draft|message/i);
    expect(done.wire).toEndWith(['tts_end', 'run_end']);

    // Exactly one message: the double-action class of bug. Skipped (reported,
    // not failed) until SMOKE_MAIL_* is configured.
    const mails = await echo.cleanup.mail.find(echo.tag);
    if (!mails.skipped) {
      expect(mails.value).toHaveLength(1);
      await echo.cleanup.mail.trash(mails.value);
    }
  });
});
