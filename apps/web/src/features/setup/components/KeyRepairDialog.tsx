import type { DeviceStatus } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { useUpdateDevice } from '@/features/devices/api/devices.mutations.ts';
import { devicesQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { isApiError } from '@/lib/api-client.ts';
import { DOC_LINKS } from '../flow.ts';

/** How long the restarted link gets to report back before we give up. */
const WAIT_MS = 12_000;
/** The link starts, fails the handshake and retries: 1 s polling is enough. */
const POLL_MS = 1000;

/**
 * The §5.2 "already secured" screen for a device that already exists (spec
 * §5.4): paste the key another app set. It saves through the existing device
 * update, which restarts the link with the new key, then watches that link:
 * connected + secured means it was the right key; `invalid-key` again means it
 * was not.
 */
export function KeyRepairDialog({
  device,
  open,
  onOpenChange,
}: {
  device: DeviceStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateDevice(device.id);
  // Poll while the dialog is open so the restarted link's report arrives.
  const devices = useQuery({ ...devicesQueryOptions(POLL_MS), enabled: open });
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const giveUpAt = useRef(0);

  const current = devices.data?.find((candidate) => candidate.id === device.id) ?? device;

  useEffect(() => {
    if (!open) {
      setKey('');
      setError(null);
      setChecking(false);
      giveUpAt.current = 0;
    }
  }, [open]);

  // A clock while waiting, so the give-up line is reached even when the polled
  // document does not change.
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [checking]);

  useEffect(() => {
    if (!checking) return;
    if (current.state === 'connected' && current.encryption === 'noise') {
      setChecking(false);
      toast.success(`${current.name} is secured.`);
      onOpenChange(false);
      return;
    }
    if (current.problem === 'invalid-key') {
      setChecking(false);
      setError("This is not the Echo's key.");
      return;
    }
    if (now >= giveUpAt.current) {
      setChecking(false);
      setError('The Echo did not accept this key. Try again.');
    }
  }, [checking, current, now, onOpenChange]);

  async function submit(): Promise<void> {
    const value = key.trim();
    if (value === '') {
      setError('Enter the key.');
      return;
    }
    setChecking(true);
    setError(null);
    // The clock starts before the request: the waiting effect must not treat
    // the time spent saving the key as "the Echo never answered".
    giveUpAt.current = Date.now() + WAIT_MS;
    try {
      await update.mutateAsync({ apiKey: value });
    } catch (caught) {
      setChecking(false);
      setError(isApiError(caught) ? (caught.fields.apiKey ?? caught.message) : 'Could not save the key.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This Echo is already secured.</DialogTitle>
          <DialogDescription>
            Another app, often Home Assistant, set a key on it. Paste that key, or remove it on the Echo and
            try again.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="repair-key">Key</Label>
            <Input
              id="repair-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              disabled={checking}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? 'repair-key-error' : undefined}
              onChange={(event) => {
                setKey(event.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id="repair-key-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            If Home Assistant also uses this Echo, remove it there first: an Echo answers only one assistant.{' '}
            <a
              href={DOC_LINKS.removeKey}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              How to remove the key ↗
            </a>
          </p>
          <div aria-live="polite" className="text-sm text-muted-foreground">
            {checking && 'Checking the key with the Echo…'}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={checking} className="w-full sm:w-auto">
              Use this key
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
