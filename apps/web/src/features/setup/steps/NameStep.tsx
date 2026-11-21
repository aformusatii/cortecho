import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { type FlowState, NAME_CHIPS } from '../flow.ts';

type NameState = Extract<FlowState, { step: 'name' }>;

/** Step 4 (spec §5.2): the room chip only fills the field; Next saves the name. */
export function NameStep({
  state,
  placeholder,
  pending,
  onChange,
  onSubmit,
  onBack,
}: {
  state: NameState;
  placeholder: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <StepHeading>Where is this Echo?</StepHeading>
      <p className="text-sm text-muted-foreground">
        The name is how you will recognise it here and in announcements.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="setup-name">Name</Label>
        <Input
          id="setup-name"
          value={state.value}
          autoComplete="off"
          maxLength={80}
          placeholder={placeholder}
          aria-invalid={Boolean(state.error) || undefined}
          aria-describedby={state.error ? 'setup-name-error' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {state.error && (
          <p id="setup-name-error" role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>

      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="sr-only">Room names</legend>
        {NAME_CHIPS.map((chip) => (
          <Button
            key={chip}
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onChange(chip)}
          >
            {chip}
          </Button>
        ))}
      </fieldset>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
