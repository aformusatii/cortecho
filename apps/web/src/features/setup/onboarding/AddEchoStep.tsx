import type { DeviceStatus } from '@cortecho/shared';
import { AddEchoFlow } from '../components/AddEchoFlow.tsx';
import { StepHeading } from '../components/StepHeading.tsx';

/** Step 4 (spec §5.1): the Add Echo flow, embedded in the onboarding card. */
export function AddEchoStep({ onDone }: { onDone: (device: DeviceStatus) => void }) {
  return (
    <div className="space-y-4">
      <StepHeading>Add your Echo</StepHeading>
      <p className="text-sm text-muted-foreground">
        Cortecho found the Echos on your network. Pick yours, hear it, and give it a name.
      </p>
      <AddEchoFlow doneLabel="Continue" onDone={onDone} />
    </div>
  );
}
