import type { DeviceKind, DiscoveredEcho } from '@cortecho/shared';
import { Loader2Icon, RotateCwIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NoEchoFound } from '../components/NoEchoFound.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import type { FlowState } from '../flow.ts';

type ChooseState = Extract<FlowState, { step: 'choose' }>;

export type ChooseStepProps = {
  state: ChooseState;
  found: readonly DiscoveredEcho[];
  scanning: boolean;
  /** The probe of a typed address is running. */
  pending: boolean;
  onSelect: (mac: string) => void;
  onNext: () => void;
  onScanAgain: () => void;
  onManualChange: (manual: boolean) => void;
  onAdvancedChange: (advanced: boolean) => void;
  onShowIgnored: (show: boolean) => void;
  onField: (key: 'host' | 'port' | 'kind', value: string) => void;
  onUnignore: (mac: string) => void;
};

/**
 * Step 1 (spec §5.2): the Echos found on the network, or an address typed by
 * hand. "Enter an address instead" stays visible: discovery can miss an Echo
 * (owner decision D5).
 */
export function ChooseStep({
  state,
  found,
  scanning,
  pending,
  onSelect,
  onNext,
  onScanAgain,
  onManualChange,
  onAdvancedChange,
  onShowIgnored,
  onField,
  onUnignore,
}: ChooseStepProps) {
  const id = useId();
  const visible = found.filter((echo) => !echo.ignored);
  const ignored = found.filter((echo) => echo.ignored);
  const nothingFound = !scanning && visible.length === 0;

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <StepHeading>Choose your Echo</StepHeading>

      {!state.manual ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Echos on your network:</p>

          {visible.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="sr-only">Echos on your network</legend>
              {visible.map((echo) => {
                const added = echo.addedAs !== null;
                const inputId = `${id}-${echo.mac}`;
                return (
                  <label
                    key={echo.mac}
                    htmlFor={inputId}
                    className={`flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
                      added ? 'opacity-60' : 'cursor-pointer hover:bg-muted'
                    }`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="discovered-echo"
                      className="mt-1 size-4 accent-primary"
                      checked={state.selectedMac === echo.mac}
                      disabled={added}
                      onChange={() => onSelect(echo.mac)}
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{echo.friendlyName}</span>
                      <span className="text-muted-foreground"> · {echo.host}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        {added ? `Added as ${echo.addedAs?.name}` : 'New'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {scanning && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
              Searching your network…
            </p>
          )}

          {nothingFound && (
            <NoEchoFound onSearchAgain={onScanAgain} onEnterAddress={() => onManualChange(true)} />
          )}

          {ignored.length > 0 &&
            (state.showIgnored ? (
              <div className="space-y-1.5">
                {ignored.map((echo) => (
                  <div key={echo.mac} className="flex min-h-11 items-center gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{echo.friendlyName}</span>
                      <span className="text-muted-foreground"> · {echo.host} · Ignored</span>
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      className="ml-auto"
                      onClick={() => onUnignore(echo.mac)}
                    >
                      Stop ignoring
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="link" onClick={() => onShowIgnored(false)}>
                  Hide ignored
                </Button>
              </div>
            ) : (
              <Button type="button" variant="link" onClick={() => onShowIgnored(true)}>
                Show ignored ({ignored.length})
              </Button>
            ))}

          {!nothingFound && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="link" onClick={() => onManualChange(true)}>
                Enter an address instead
              </Button>
              {!scanning && (
                <Button type="button" variant="ghost" onClick={onScanAgain}>
                  <RotateCwIcon aria-hidden="true" /> Search again
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="setup-host">Address</Label>
            <Input
              id="setup-host"
              value={state.host}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              placeholder="192.168.1.50"
              aria-invalid={Boolean(state.errors.host) || undefined}
              aria-describedby={state.errors.host ? 'setup-host-error' : undefined}
              onChange={(event) => onField('host', event.target.value)}
            />
            {state.errors.host && (
              <p id="setup-host-error" role="alert" className="text-sm text-destructive">
                {state.errors.host}
              </p>
            )}
          </div>

          <details
            className="rounded-lg border px-3 py-2"
            open={state.advanced}
            onToggle={(event) => onAdvancedChange(event.currentTarget.open)}
          >
            <summary className="min-h-11 cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="setup-port">Port</Label>
                <Input
                  id="setup-port"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  value={state.port}
                  aria-invalid={Boolean(state.errors.port) || undefined}
                  aria-describedby={state.errors.port ? 'setup-port-error' : undefined}
                  onChange={(event) => onField('port', event.target.value)}
                />
                {state.errors.port && (
                  <p id="setup-port-error" role="alert" className="text-sm text-destructive">
                    {state.errors.port}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-kind">Kind</Label>
                <select
                  id="setup-kind"
                  value={state.kind}
                  onChange={(event) => onField('kind', event.target.value as DeviceKind)}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="echo">Echo</option>
                  <option value="test">Test device</option>
                </select>
              </div>
            </div>
          </details>

          <Button type="button" variant="link" onClick={() => onManualChange(false)}>
            Choose from the network instead
          </Button>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Checking the address…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
