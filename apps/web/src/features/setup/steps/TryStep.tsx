import { Button } from '@/components/ui/button.tsx';
import { StepHeading } from '../components/StepHeading.tsx';

export type TryPhase = 'waiting' | 'listening' | 'thinking' | 'heard' | 'nothing';

/**
 * Step 5 (spec §5.2): the owner speaks the wake word. The flow polls the
 * device and its latest turn; this view only renders the four states.
 */
export function TryStep({
  phase,
  transcript,
  seconds,
  onSkip,
}: {
  phase: TryPhase;
  transcript: string | null;
  seconds: number | null;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <StepHeading>Say: "Computer, what time is it?"</StepHeading>

      <div aria-live="polite" className="space-y-2 text-sm">
        {phase === 'waiting' && (
          <>
            <p className="font-medium">◉ Waiting for the wake word…</p>
            <p className="text-muted-foreground">The wake word is set on the Echo (Alexa by default).</p>
          </>
        )}
        {phase === 'listening' && <p className="font-medium">◉ Listening…</p>}
        {phase === 'thinking' && <p className="font-medium">◉ Thinking…</p>}
        {phase === 'heard' && (
          <p className="font-medium">
            ✓ Heard “{transcript ?? 'you'}”{seconds !== null ? ` · answered in ${seconds.toFixed(1)} s` : ''}
          </p>
        )}
        {phase === 'nothing' && (
          <p className="text-muted-foreground">
            Nothing heard yet. Speak from a couple of metres away, or skip this step.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="ghost" onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
