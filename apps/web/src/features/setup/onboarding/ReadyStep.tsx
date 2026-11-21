import { Button } from '@/components/ui/button.tsx';
import { StepHeading } from '../components/StepHeading.tsx';

/** The finish (spec §5.1): one thing to say, and where to go next. */
export function ReadyStep({ name, onDone }: { name: string; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <StepHeading>Cortecho is ready</StepHeading>
      <p className="text-sm text-muted-foreground">Say “Computer, what time is it?” to {name} any time.</p>
      <p className="text-sm text-muted-foreground">
        Next: give it more skills in Settings → Connectors, or add another Echo.
      </p>
      <div className="flex justify-end pt-2">
        <Button type="button" onClick={onDone} className="w-full sm:w-auto">
          Go to Status
        </Button>
      </div>
    </div>
  );
}
