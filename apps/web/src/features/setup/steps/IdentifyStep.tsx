import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import type { FlowState } from '../flow.ts';

type IdentifyState = Extract<FlowState, { step: 'identify' }>;

export type IdentifyStepProps = {
  state: IdentifyState;
  /** The address on screen came from the page's own origin. */
  suggested: boolean;
  onYes: () => void;
  onNo: () => void;
  onPlayAgain: () => void;
  onAddressChange: (value: string) => void;
  onSaveAddress: () => void;
};

/**
 * Step 3 (spec §5.2): the Echo identifies itself by playing the chime. Not
 * downloaded → the reply-address screen, because the Echo fetches every answer
 * from Cortecho.
 */
export function IdentifyStep({
  state,
  suggested,
  onYes,
  onNo,
  onPlayAgain,
  onAddressChange,
  onSaveAddress,
}: IdentifyStepProps) {
  if (state.status === 'address') {
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveAddress();
        }}
      >
        <StepHeading>Your Echo cannot reach Cortecho</StepHeading>
        <p className="text-sm text-muted-foreground">
          The Echo downloads every answer from this computer. Enter this computer's address on your network.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="setup-reply-address">Address</Label>
          <Input
            id="setup-reply-address"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://192.168.1.10:3000"
            value={state.address}
            aria-invalid={Boolean(state.addressError) || undefined}
            aria-describedby={state.addressError ? 'setup-reply-address-error' : 'setup-reply-address-help'}
            onChange={(event) => onAddressChange(event.target.value)}
          />
          {state.addressError ? (
            <p id="setup-reply-address-error" role="alert" className="text-sm text-destructive">
              {state.addressError}
            </p>
          ) : (
            suggested && (
              <p id="setup-reply-address-help" className="text-xs text-muted-foreground">
                Suggested from the address you opened this page with.
              </p>
            )
          )}
        </div>
        <div className="flex justify-end">
          <Button type="submit" className="w-full sm:w-auto">
            Save and play again
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <StepHeading>Listen…</StepHeading>
      <p className="text-sm text-muted-foreground">Cortecho is playing a sound on this Echo.</p>

      <div aria-live="polite" className="space-y-3 text-sm">
        {state.status === 'connecting' && (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            Connecting to the Echo…
          </p>
        )}

        {state.status === 'playing' && (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            Playing a sound…
          </p>
        )}

        {state.soundError && (
          <div className="space-y-2">
            <p role="alert" className="text-destructive">
              {state.soundError}
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onPlayAgain}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {state.status === 'asking' && (
          <div className="space-y-3">
            <p className="font-medium">Did you hear it?</p>
            {state.notConfirmed && (
              <p className="text-muted-foreground">The Echo downloaded it but did not confirm playing.</p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={onPlayAgain}>
                Play again
              </Button>
              <Button type="button" variant="ghost" onClick={onNo}>
                No
              </Button>
              <Button type="button" onClick={onYes} className="w-full sm:w-auto">
                Yes
              </Button>
            </div>
          </div>
        )}

        {state.status === 'quiet' && (
          <div className="space-y-3">
            <p className="font-medium">Turn the volume up on the Echo (the + button) and play again.</p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onPlayAgain}>
                Play again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
