import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// Owner decision 2026-11-21: a clear request runs the tool at once, with no
// extra "yes". (`confirm` stays a per-tool opt-in, covered by unit tests.) The
// tool name depends on the configured mail connector, so it is matched loosely.
/** The model's wording varies ("Say yes and I'll save it", "Shall I send it?"). */
const CONFIRM_QUESTION = /say\W+yes|should I|shall I|are you sure|do you want|want me to/i;

describe('a clear request runs the tool at once', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('saves the draft without asking for a yes', async () => {
    const subject = `smoke test ${echo.tag} passed`;
    const done = await echo.wake(`Save an email draft to myself saying ${subject}`);
    expect(done.listensAgain).toBe(false);
    expect(done.said ?? '').not.toMatch(CONFIRM_QUESTION);
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
