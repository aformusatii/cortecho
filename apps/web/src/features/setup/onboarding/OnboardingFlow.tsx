import type { DeviceStatus, SettingsDocument } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { devicesQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { useSaveSettings } from '@/features/settings/api/settings.mutations.ts';
import { settingsQueryOptions } from '@/features/settings/api/settings.queries.ts';
import { isApiError } from '@/lib/api-client.ts';
import { useCheckOpenAi, useCompleteSetup } from '../api/setup.mutations.ts';
import { setupQueryOptions } from '../api/setup.queries.ts';
import { AddEchoStep } from './AddEchoStep.tsx';
import { HomeStep } from './HomeStep.tsx';
import { OpenAiStep } from './OpenAiStep.tsx';
import {
  browserLocale,
  browserTimeZone,
  ONBOARDING_STEPS,
  type OnboardingStep,
  stepCount,
  stepNumber,
  visibleOnboardingSteps,
} from './onboarding.ts';
import { ReadyStep } from './ReadyStep.tsx';
import { WelcomeStep } from './WelcomeStep.tsx';

/**
 * The first-launch onboarding (spec §5.1): Welcome → Your home → Connect
 * OpenAI → Add your Echo, then the Ready screen. `rerun` is the explicit "Run
 * the first-time setup again": it shows every step, prefilled, and skips
 * nothing.
 */
export function OnboardingFlow({ rerun, onSkip }: { rerun: boolean; onSkip: () => void }) {
  const navigate = useNavigate();
  const setup = useQuery(setupQueryOptions());
  const settings = useQuery(settingsQueryOptions());
  const devices = useQuery(devicesQueryOptions());
  const saveSettings = useSaveSettings();
  const checkOpenAi = useCheckOpenAi();
  const completeSetup = useCompleteSetup();

  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [ready, setReady] = useState(false);
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [locale, setLocale] = useState(browserLocale);
  const [homeErrors, setHomeErrors] = useState<Record<string, string>>({});
  const [homePending, setHomePending] = useState(false);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [storedKey, setStoredKey] = useState<'unknown' | 'checking' | 'ok' | 'bad'>('unknown');
  const [added, setAdded] = useState<DeviceStatus | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const checkedStored = useRef(false);

  // The mode is fixed when the flow opens: adopting the Echo completes the
  // onboarding server-side, and that answer must not turn a first launch into
  // a re-run halfway through.
  const rerunMode = useRef(rerun).current;
  const homeConfirmed = setup.data?.homeConfirmed === true;
  const openAiOk = !rerunMode && storedKey === 'ok';
  const visible = visibleOnboardingSteps({
    homeConfirmed,
    openAiOk,
    rerun: rerunMode,
    hasEcho: setup.data?.hasEcho === true,
  });
  // A step can leave the sequence while it is open (the stored key turned out
  // to be valid). Rendering the next visible step handles that without another
  // effect; `step` keeps the raw position for the advance logic.
  const current = resolveCurrentStep(step, visible);

  // One check of a stored key decides whether the OpenAI step can be skipped
  // (spec §5.1). It runs in the background: the Welcome step is usable at once.
  useEffect(() => {
    if (checkedStored.current || rerunMode) return;
    if (!setup.data?.hasOpenAiKey) return;
    checkedStored.current = true;
    setStoredKey('checking');
    checkOpenAi.mutate(
      {},
      {
        onSuccess: (result) => setStoredKey(result.ok ? 'ok' : 'bad'),
        onError: () => setStoredKey('bad'),
      },
    );
  }, [setup.data?.hasOpenAiKey, rerunMode, checkOpenAi]);

  // Focus each new step's heading (spec §5.7).
  const focusKey = ready ? 'ready' : current;
  useEffect(() => {
    if (!focusKey) return;
    const frame = requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>('[data-flow-heading]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  function advance(from: OnboardingStep): void {
    const index = visible.indexOf(from);
    const following = index >= 0 ? visible[index + 1] : undefined;
    if (following) {
      setStep(following);
      return;
    }
    finish();
  }

  function finish(device: DeviceStatus | null = added): void {
    setAdded(device);
    setReady(true);
    completeSetup.mutate();
  }

  async function writeSettings(changes: Record<string, unknown>): Promise<SettingsDocument> {
    const document = settings.data;
    if (!document) throw new Error('The settings are still loading.');
    try {
      return await saveSettings.mutateAsync({ version: document.version, changes });
    } catch (error) {
      // Another tab saved first: take its version and write once more.
      if (!isApiError(error) || error.status !== 409) throw error;
      const next = await settings.refetch();
      const version = next.data?.version;
      if (version === undefined) throw error;
      return await saveSettings.mutateAsync({ version, changes });
    }
  }

  async function saveHome(): Promise<void> {
    setHomePending(true);
    setHomeErrors({});
    try {
      await writeSettings({ 'assistant.timeZone': timeZone.trim(), 'assistant.locale': locale });
      advance('home');
    } catch (error) {
      setHomeErrors(
        isApiError(error) && Object.keys(error.fields).length > 0
          ? error.fields
          : { 'assistant.timeZone': errorMessage(error) },
      );
    } finally {
      setHomePending(false);
    }
  }

  async function submitOpenAi(): Promise<void> {
    const typed = key.trim();
    setChecking(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      // The key is saved first: it is write-only and the AI needs it anyway.
      if (typed !== '') await writeSettings({ 'openai.apiKey': typed });
      const result = await checkOpenAi.mutateAsync(typed !== '' ? { apiKey: typed } : {});
      if (result.ok) {
        setKey('');
        advance('openai');
        return;
      }
      setKeyNotice(
        result.code === 'rejected'
          ? 'OpenAI rejected this key.'
          : "Cortecho cannot reach OpenAI. Check this computer's internet connection.",
      );
    } catch (error) {
      if (isApiError(error)) setKeyError(error.fields['openai.apiKey'] ?? error.message);
      else setKeyError(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  const firstEcho = devices.data?.find((device) => device.kind === 'echo') ?? null;
  const readyName = added?.name ?? firstEcho?.name ?? 'your Echo';

  if (ready) {
    return (
      <div
        ref={containerRef}
        className="mx-auto w-full max-w-[560px] rounded-xl border bg-card p-6 shadow-xs"
      >
        <ReadyStep name={readyName} onDone={() => void navigate({ to: '/' })} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-[560px] rounded-xl border bg-card p-6 shadow-xs">
      <h1 className="sr-only">Setup</h1>
      <p className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Step {stepNumber(current)} of {stepCount()}
      </p>

      {current === 'welcome' && <WelcomeStep onStart={() => advance('welcome')} onSkip={onSkip} />}

      {current === 'home' && (
        <HomeStep
          timeZone={timeZone}
          locale={locale}
          errors={homeErrors}
          pending={homePending}
          onTimeZone={setTimeZone}
          onLocale={setLocale}
          onNext={() => void saveHome()}
        />
      )}

      {current === 'openai' &&
        (storedKey === 'checking' ? (
          <div role="status" className="space-y-3">
            <p className="text-sm text-muted-foreground">Checking your OpenAI key…</p>
          </div>
        ) : (
          <OpenAiStep
            value={key}
            error={keyError}
            notice={keyNotice}
            checking={checking}
            onChange={setKey}
            onSubmit={() => void submitOpenAi()}
          />
        ))}

      {current === 'echo' && (
        <AddEchoStep
          onDone={(device) => {
            setAdded(device);
            finish(device);
          }}
        />
      )}
    </div>
  );
}

/**
 * The step to render: the raw position unless it is not in the sequence (a
 * valid stored key removed the OpenAI step), then the next visible one.
 */
function resolveCurrentStep(step: OnboardingStep, visible: readonly OnboardingStep[]): OnboardingStep {
  if (visible.includes(step)) return step;
  const position = ONBOARDING_STEPS.indexOf(step);
  return visible.find((candidate) => ONBOARDING_STEPS.indexOf(candidate) > position) ?? visible[0] ?? step;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
