import type { SmokeEnv } from './env.ts';

/**
 * Side-effect verification and cleanup (spec §6.4). Mail is the first target:
 * a scenario sends a message and checks it arrived exactly once, then trashes
 * it. The access route was left open in M4, so today there is only the `skip`
 * implementation — when `SMOKE_MAIL_*` is not configured, `find`/`trash`
 * return `{ skipped: true, reason }` and the scenario reports that instead of
 * failing. A future implementation plugs into the same `Mail` interface.
 */

export type MailResult<T> = { skipped: false; value: T } | { skipped: true; reason: string };

export type MailMessage = { id: string; subject: string };

export type Mail = {
  /** Messages matching the run id; exactly one is the double-send check. */
  find(runId: string): Promise<MailResult<MailMessage[]>>;
  /** Move messages to the trash. */
  trash(messages: MailMessage[]): Promise<MailResult<number>>;
};

export type Cleanup = {
  mail: Mail;
};

/** The skip implementation: reported, never a failure. */
const skipMail: Mail = {
  async find(): Promise<MailResult<MailMessage[]>> {
    return { skipped: true, reason: 'SMOKE_MAIL_* is not configured' };
  },
  async trash(): Promise<MailResult<number>> {
    return { skipped: true, reason: 'SMOKE_MAIL_* is not configured' };
  },
};

export function createCleanup(_env: SmokeEnv): Cleanup {
  return { mail: skipMail };
}
