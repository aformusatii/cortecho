import { isFirstLaunch } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useRestartSetup } from '../api/setup.mutations.ts';
import { setupQueryOptions } from '../api/setup.queries.ts';
import { AddEchoFlow } from '../components/AddEchoFlow.tsx';
import { markOnboardingShown } from '../first-launch.ts';
import { OnboardingFlow } from '../onboarding/OnboardingFlow.tsx';

/**
 * `/setup` (owner decision D5): on a first launch the onboarding, always the
 * Add Echo flow. The flow itself is the same component the dialog uses.
 */
export function SetupPage() {
  const setup = useQuery(setupQueryOptions());
  const restart = useRestartSetup();
  const navigate = useNavigate();
  const [flowKey, setFlowKey] = useState(0);
  // Once the onboarding was entered, it stays until the page is left: the
  // completion write must not swap the Ready screen for the Add Echo flow.
  const [onboarding, setOnboarding] = useState(false);
  // An explicit re-run shows every step: the skips only apply to a first launch.
  const [rerun, setRerun] = useState(false);

  const firstLaunch = setup.data ? isFirstLaunch(setup.data) : false;
  const showOnboarding = onboarding || firstLaunch;

  // The redirect decision is per tab (spec §4): "Skip for now" and the nav
  // must reach the status page, where the banner waits.
  useEffect(() => {
    if (firstLaunch) {
      markOnboardingShown();
      setOnboarding(true);
    }
  }, [firstLaunch]);

  if (setup.isPending) {
    return (
      <div role="status" aria-busy="true" className="mx-auto w-full max-w-[560px] space-y-3">
        <span className="sr-only">Loading the setup…</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (showOnboarding) {
    return <OnboardingFlow rerun={rerun} onSkip={() => void navigate({ to: '/' })} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Setup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add an Echo to Cortecho. Discovery finds it on your network, or enter its address by hand.
          </p>
        </div>
        <Button
          variant="link"
          size="sm"
          disabled={restart.isPending}
          onClick={() =>
            restart.mutate(undefined, {
              onSuccess: () => {
                setRerun(true);
                setOnboarding(true);
              },
              onError: (error) => toast.error(error.message),
            })
          }
        >
          Run the first-time setup again
        </Button>
      </header>

      <section
        aria-label="Add an Echo"
        className="mx-auto w-full max-w-2xl rounded-xl border bg-card p-4 shadow-xs sm:p-6"
      >
        <AddEchoFlow
          key={flowKey}
          onDone={(device) => {
            toast.success(`Added ${device.name}.`);
            setFlowKey((key) => key + 1);
          }}
        />
      </section>
    </div>
  );
}
