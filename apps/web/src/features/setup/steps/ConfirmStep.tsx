import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { DOC_LINKS, type FlowState, targetLabel } from '../flow.ts';

type ConfirmState = Extract<FlowState, { step: 'confirm' }>;

export type ConfirmStepProps = {
  state: ConfirmState;
  onAdd: () => void;
  onUseKey: () => void;
  onKeyChange: (key: string) => void;
  onBack: () => void;
  onTryAgain: () => void;
  onChangeAddress: () => void;
  onOpenDevice: (id: number) => void;
};

/**
 * Step 2 (spec §5.2): one question, then the live checklist behind
 * `POST /api/devices/adopt`, and every branch the adoption can end in.
 */
export function ConfirmStep({
  state,
  onAdd,
  onUseKey,
  onKeyChange,
  onBack,
  onTryAgain,
  onChangeAddress,
  onOpenDevice,
}: ConfirmStepProps) {
  const label = targetLabel(state.target);

  if (state.mode === 'needs-key') {
    return (
      <div className="space-y-4">
        <StepHeading>This Echo is already secured.</StepHeading>
        <p className="text-sm text-muted-foreground">
          Another app, often Home Assistant, set a key on it. Paste that key, or remove it on the Echo and try
          again.
        </p>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            onUseKey();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="setup-key">Key</Label>
            <Input
              id="setup-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={state.key}
              aria-invalid={Boolean(state.keyError) || undefined}
              aria-describedby={state.keyError ? 'setup-key-error' : undefined}
              onChange={(event) => onKeyChange(event.target.value)}
            />
            {state.keyError && (
              <p id="setup-key-error" role="alert" className="text-sm text-destructive">
                {state.keyError}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
            <a
              href={DOC_LINKS.removeKey}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
            >
              How to remove the key ↗
            </a>
            <Button type="submit" disabled={state.key.trim() === ''} className="w-full sm:ml-auto sm:w-auto">
              Use this key
            </Button>
          </div>
        </form>
        <p className="text-xs text-muted-foreground">
          If Home Assistant also uses this Echo, remove it there first: an Echo answers only one assistant.
        </p>
      </div>
    );
  }

  if (state.mode === 'problem' && state.problem) {
    const problem = state.problem;
    const deviceId = problem.deviceId;
    return (
      <div className="space-y-4" aria-live="polite">
        {problem.kind === 'unreachable' && (
          <>
            <StepHeading>Cannot reach the Echo.</StepHeading>
            <p className="text-sm text-muted-foreground">
              Nothing answered at {state.target.host}. Is it plugged in and on the same network?
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={onChangeAddress}>
                Change address
              </Button>
              <Button type="button" onClick={onTryAgain} className="w-full sm:w-auto">
                Try again
              </Button>
            </div>
          </>
        )}

        {problem.kind === 'not-an-echo' && (
          <>
            <StepHeading>This is not an Echo with echo-dot-assist.</StepHeading>
            <p className="text-sm text-muted-foreground">
              The device at this address does not offer a voice assistant.
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onChangeAddress}>
                Change address
              </Button>
            </div>
          </>
        )}

        {problem.kind === 'already-added' && (
          <>
            <StepHeading>
              {problem.name ? `Already added as ${problem.name}.` : 'This Echo is already added.'}
            </StepHeading>
            {!problem.name && <p className="text-sm text-muted-foreground">{problem.message}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={onChangeAddress}>
                Change address
              </Button>
              {deviceId !== undefined && (
                <Button type="button" className="w-full sm:w-auto" onClick={() => onOpenDevice(deviceId)}>
                  {`Open ${problem.name ?? 'it'}`}
                </Button>
              )}
            </div>
          </>
        )}

        {problem.kind === 'failed' && (
          <>
            <StepHeading>Could not secure the Echo.</StepHeading>
            <p className="text-sm text-muted-foreground">Nothing was changed.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={onChangeAddress}>
                Change address
              </Button>
              <Button type="button" onClick={onTryAgain} className="w-full sm:w-auto">
                Try again
              </Button>
            </div>
          </>
        )}

        {problem.detail && <p className="font-mono text-xs text-muted-foreground">{problem.detail}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StepHeading>{`Add ${label}?`}</StepHeading>
      <p className="text-sm text-muted-foreground">
        Cortecho will connect to it and secure the connection with a new key. Nothing else on the Echo
        changes.
      </p>

      {state.mode === 'adopting' || state.mode === 'adopted' ? (
        <ul role="status" aria-live="polite" aria-busy="true" className="space-y-1.5 text-sm">
          <li className="text-muted-foreground">✓ Found the Echo</li>
          {state.mode === 'adopted' ? (
            <>
              <li className="text-muted-foreground">✓ Secured</li>
              <li className="text-muted-foreground">✓ Connected</li>
            </>
          ) : (
            <>
              <li className="flex items-center gap-2 font-medium">
                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                Securing the connection…
              </li>
              <li className="text-muted-foreground">○ Connecting</li>
            </>
          )}
        </ul>
      ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="button" onClick={onAdd} className="w-full sm:w-auto">
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
