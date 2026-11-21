import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { appState } from '../../db/schema.ts';

/** The only app_state row this feature owns (spec §8.3). */
const ONBOARDING_KEY = 'onboarding.completedAt';

/**
 * First-launch state in `app_state`. It is not a behaviour setting (no
 * descriptor, not in the settings history): it only decides whether the
 * onboarding still shows. A timestamp is stored as the value so the row says
 * when it happened.
 */
export function createSetupRepository(db: Db) {
  function onboardingCompletedAt(): string | null {
    const row = db.select().from(appState).where(eq(appState.key, ONBOARDING_KEY)).get();
    return row?.value ?? null;
  }

  return {
    onboardingCompletedAt,

    /**
     * The first completion wins: adopting a second Echo must not move the
     * timestamp, and a second tab finishing the wizard must not rewrite it.
     */
    completeOnboarding(at = new Date().toISOString()): string {
      db.insert(appState)
        .values({ key: ONBOARDING_KEY, value: at, updatedAt: at })
        .onConflictDoNothing({ target: appState.key })
        .run();
      return onboardingCompletedAt() ?? at;
    },

    /** "Run the first-time setup again": forget the completion. */
    restartOnboarding(): void {
      db.delete(appState).where(eq(appState.key, ONBOARDING_KEY)).run();
    },
  };
}

export type SetupRepository = ReturnType<typeof createSetupRepository>;
