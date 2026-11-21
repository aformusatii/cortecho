import { SETTING_BY_KEY } from '@cortecho/shared';

/**
 * The first-launch onboarding's steps (spec §5.1). The four numbered steps are
 * Welcome, Your home, Connect OpenAI and Add your Echo; the Ready screen after
 * them is the finish, not another numbered step.
 */

export type OnboardingStep = 'welcome' | 'home' | 'openai' | 'echo';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['welcome', 'home', 'openai', 'echo'];

/** Where the docs explain the things the wizard only mentions. */
export const ONBOARDING_LINKS = {
  prepareEcho: 'https://github.com/aformusatii/cortecho/blob/main/docs/echo-setup.md',
  getKey: 'https://platform.openai.com/api-keys',
} as const;

export const LOCALE_OPTIONS: readonly string[] =
  (SETTING_BY_KEY.get('assistant.locale')?.options as readonly string[] | undefined) ?? [];

/**
 * Which steps are shown. On a first launch a step whose answer is already
 * known is skipped (spec §5.1: the Home step when the settings history has the
 * key, the OpenAI step when the stored key passed the check). An explicit
 * "Run the first-time setup again" never skips: the owner asked to see them.
 */
export function visibleOnboardingSteps({
  homeConfirmed,
  openAiOk,
  rerun,
  hasEcho,
}: {
  homeConfirmed: boolean;
  openAiOk: boolean;
  rerun: boolean;
  hasEcho: boolean;
}): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    // An explicit re-run with an Echo already added has nothing to add; the
    // steps that are worth re-running are the home and OpenAI ones.
    if (step === 'echo') return !(rerun && hasEcho);
    // The skips only apply on a first launch: the owner asked for the steps.
    if (rerun) return true;
    if (step === 'home') return !homeConfirmed;
    if (step === 'openai') return !openAiOk;
    return true;
  });
}

/** "Step 2 of 4": skipped steps keep their number, so the count never shrinks. */
export function stepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export function stepCount(): number {
  return ONBOARDING_STEPS.length;
}

/** The browser's zone, prefilled into the Home step (spec §5.1). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The browser's language when the registry offers it, else the built-in default. */
export function browserLocale(): string {
  const language = typeof navigator === 'undefined' ? '' : navigator.language;
  if (LOCALE_OPTIONS.includes(language)) return language;
  return 'en-US';
}

/** Every IANA zone for the combobox; an old engine simply offers none. */
export function timeZoneSuggestions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}
