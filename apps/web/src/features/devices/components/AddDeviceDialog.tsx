import type { DeviceCreate, DeviceKind } from '@cortecho/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { isApiError } from '@/lib/api-client.ts';
import { useCreateDevice } from '../api/devices.mutations.ts';

type Form = {
  name: string;
  kind: DeviceKind;
  host: string;
  port: string;
  apiKey: string;
  enabled: boolean;
};

const EMPTY: Form = { name: '', kind: 'echo', host: '', port: '26053', apiKey: '', enabled: true };

/**
 * Add an Echo: name, address and (optional) key. Prompt and tuning live on the
 * Echo's own page, so this form stays short. A duplicate name or address is a
 * 409 whose field the API names.
 */
export function AddDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateDevice();

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function close(next: boolean) {
    if (!next) {
      setForm(EMPTY);
      setErrors({});
    }
    onOpenChange(next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const port = Number(form.port);
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Enter a name.';
    if (!form.host.trim()) found.host = 'Enter an address.';
    if (!Number.isInteger(port) || port < 1 || port > 65535) found.port = 'Use a port between 1 and 65535.';
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    const input: DeviceCreate = {
      name: form.name.trim(),
      kind: form.kind,
      host: form.host.trim(),
      port,
      enabled: form.enabled,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    };
    create.mutate(input, {
      onSuccess: (device) => {
        toast.success(`Added ${device.name}.`);
        close(false);
      },
      onError: (error) => {
        if (isApiError(error)) {
          setErrors(error.fields);
          toast.error(error.fields[Object.keys(error.fields)[0] ?? ''] ?? error.message);
        } else {
          toast.error(error instanceof Error ? error.message : 'Could not add the Echo.');
        }
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add an Echo</DialogTitle>
            <DialogDescription>
              hassmic in ESPHome mode on the Echo's address. The key is optional but the Echo needs it to
              receive the time.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="new-device-name">Name</Label>
            <Input
              id="new-device-name"
              value={form.name}
              autoComplete="off"
              aria-invalid={Boolean(errors.name) || undefined}
              aria-describedby={errors.name ? 'new-device-name-error' : undefined}
              onChange={(event) => set('name', event.target.value)}
            />
            {errors.name && (
              <p id="new-device-name-error" role="alert" className="text-sm text-destructive">
                {errors.name}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-device-kind">Kind</Label>
              <select
                id="new-device-kind"
                value={form.kind}
                onChange={(event) => set('kind', event.target.value as DeviceKind)}
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="echo">Echo</option>
                <option value="test">Test device</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-device-port">Port</Label>
              <Input
                id="new-device-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={form.port}
                aria-invalid={Boolean(errors.port) || undefined}
                aria-describedby={errors.port ? 'new-device-port-error' : undefined}
                onChange={(event) => set('port', event.target.value)}
              />
              {errors.port && (
                <p id="new-device-port-error" role="alert" className="text-sm text-destructive">
                  {errors.port}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-device-host">Address</Label>
            <Input
              id="new-device-host"
              value={form.host}
              autoComplete="off"
              spellCheck={false}
              placeholder="192.168.1.50"
              aria-invalid={Boolean(errors.host) || undefined}
              aria-describedby={errors.host ? 'new-device-host-error' : undefined}
              onChange={(event) => set('host', event.target.value)}
            />
            {errors.host ? (
              <p id="new-device-host-error" role="alert" className="text-sm text-destructive">
                {errors.host}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                A private LAN address (10/8, 172.16/12, 192.168/16) or 127.0.0.1.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-device-key">API key</Label>
            <Input
              id="new-device-key"
              type="password"
              autoComplete="new-password"
              placeholder="Optional: base64 of 32 bytes"
              value={form.apiKey}
              aria-invalid={Boolean(errors.apiKey) || undefined}
              aria-describedby={errors.apiKey ? 'new-device-key-error' : 'new-device-key-help'}
              onChange={(event) => set('apiKey', event.target.value)}
            />
            <p id="new-device-key-help" className="text-xs text-muted-foreground">
              Leave empty for a plaintext link. Without a key the Echo cannot receive the time.
            </p>
            {errors.apiKey && (
              <p id="new-device-key-error" role="alert" className="text-sm text-destructive">
                {errors.apiKey}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="new-device-enabled" className="text-sm">
              Connect now
            </Label>
            <Switch
              id="new-device-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => set('enabled', checked)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add Echo'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
