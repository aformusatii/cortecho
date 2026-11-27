import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resultExcerpt } from '../harness/report.ts';
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
    const calls = done.turn?.toolCalls ?? [];
    const call = calls.find((candidate) => /mail|draft|message/i.test(candidate.name));
    if (!call) {
      throw new Error(
        `expected a mail/draft tool call, saw: ${calls.map((candidate) => candidate.name).join(', ') || '(none)'}`,
      );
    }
    // The name alone is not enough: an unauthorized connector answers with a
    // friendly "I couldn't save the draft" while the call itself failed.
    expect(
      call.ok === true && call.pending !== true,
      `${call.name} ${call.pending ? 'is pending (not run)' : 'failed'}: ${resultExcerpt(call.result)}`,
    ).toBe(true);
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
