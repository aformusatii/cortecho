import { Button } from '@/components/ui/button.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { ONBOARDING_LINKS } from './onboarding.ts';

/** Step 1 (spec §5.1): what this is, what it needs, and the way out. */
export function WelcomeStep({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="space-y-4">
      <StepHeading>Welcome to Cortecho</StepHeading>
      <p className="text-sm text-muted-foreground">
        Cortecho is the brain for your Echo Dot: it listens, thinks and answers with your own AI. Setup takes
        about three minutes.
      </p>
      <p className="text-sm text-muted-foreground">
        Before you start: your Echo runs echo-dot-assist and is on the same network as this computer.{' '}
        <a
          href={ONBOARDING_LINKS.prepareEcho}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-4"
        >
          How to prepare an Echo ↗
        </a>
      </p>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end">
        <Button type="button" variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button type="button" onClick={onStart} className="w-full sm:w-auto">
          Get started
        </Button>
      </div>
    </div>
  );
}
