import { isFirstLaunch, type SetupDocument } from '@cortecho/shared';

const SHOWN_KEY = 'cortecho.setup.onboardingShown';

/**
 * The `/` redirect is a first-visit routing decision, not a wall. "Skip for
 * now" must reach the status page (§4, where its banner waits), and the nav
 * must stay usable while the wizard is open, so once the onboarding was shown
 * in this tab `/` renders normally. The banner and the Setup page keep
 * reminding the owner until an Echo exists.
 */
export function shouldRedirectToSetup(document: SetupDocument): boolean {
  return isFirstLaunch(document) && !onboardingShown();
}

/** Called by the Setup page when it renders the first-launch onboarding. */
export function markOnboardingShown(): void {
  try {
    window.sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    // Privacy modes can throw on storage; the redirect then simply repeats.
  }
}

export function onboardingShown(): boolean {
  try {
    return window.sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}
