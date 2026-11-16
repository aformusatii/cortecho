import type { DeviceKind, DeviceStatus, DeviceUpdate } from '@cortecho/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { isApiError } from '@/lib/api-client.ts';
import { useAcceptDevice, useUpdateDevice } from '../api/devices.mutations.ts';

type Form = {
  name: string;
  kind: DeviceKind;
  host: string;
  port: string;
  apiKey: string;
  enabled: boolean;
};

function formOf(device: DeviceStatus): Form {
  return {
    name: device.name,
    kind: device.kind,
    host: device.host,
    port: String(device.port),
    apiKey: '',
    enabled: device.enabled,
  };
}

/**
 * The connection: what the gateway dials. An empty key field keeps the stored
 * key; "Remove key" sends `apiKey: null` and makes the link plaintext again.
 * Changing the address, port, key or enabled restarts the link, as the note says.
 */
export function ConnectionTab({ device }: { device: DeviceStatus }) {
  const [form, setForm] = useState<Form>(() => formOf(device));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removeKey, setRemoveKey] = useState(false);
  const update = useUpdateDevice(device.id);
  const accept = useAcceptDevice();

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const port = Number(form.port);
    const changes: DeviceUpdate = {};
    if (form.name.trim() !== device.name) changes.name = form.name.trim();
    if (form.kind !== device.kind) changes.kind = form.kind;
    if (form.host.trim() !== device.host) changes.host = form.host.trim();
    if (port !== device.port) changes.port = port;
    if (form.enabled !== device.enabled) changes.enabled = form.enabled;
    if (removeKey) changes.apiKey = null;
    else if (form.apiKey.trim() !== '') changes.apiKey = form.apiKey.trim();

    if (Object.keys(changes).length === 0) {
      toast.info('Nothing changed.');
      return;
    }
    update.mutate(changes, {
      onSuccess: () => {
        toast.success('Saved.');
        setForm((previous) => ({ ...previous, apiKey: '' }));
        setRemoveKey(false);
      },
      onError: (error) => {
        if (isApiError(error)) {
          setErrors(error.fields);
          toast.error(error.message);
        } else toast.error(error instanceof Error ? error.message : 'Could not save.');
      },
    });
  }

  const restarting = changesWouldRestart(form, device, removeKey) && update.isPending;

  return (
    <div className="space-y-4">
      {device.problem === 'unexpected-device' && (
        <Alert>
          <AlertTitle>Another Echo answers at this address</AlertTitle>
          <AlertDescription>
            The node name it reports is not the one accepted before. If this is the Echo you mean to use,
            accept it; otherwise fix the address.
            <span className="mt-2 block">
              <Button
                type="button"
                size="sm"
                disabled={accept.isPending}
                onClick={() =>
                  accept.mutate(device.id, {
                    onSuccess: () => toast.success('Accepted the new device.'),
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                {accept.isPending ? 'Accepting…' : 'Accept new device'}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={save} className="space-y-4 rounded-xl border bg-card p-4 shadow-xs">
        <div className="space-y-1.5">
          <Label htmlFor="device-name">Name</Label>
          <Input
            id="device-name"
            value={form.name}
            autoComplete="off"
            aria-invalid={Boolean(errors.name) || undefined}
            aria-describedby={errors.name ? 'device-name-error' : undefined}
            onChange={(event) => set('name', event.target.value)}
          />
          {errors.name && (
            <p id="device-name-error" role="alert" className="text-sm text-destructive">
              {errors.name}
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="device-kind">Kind</Label>
            <select
              id="device-kind"
              value={form.kind}
              onChange={(event) => set('kind', event.target.value as DeviceKind)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="echo">Echo</option>
              <option value="test">Test device</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Test devices log quietly and are left out of “all Echos” announcements.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="device-port">Port</Label>
            <Input
              id="device-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port}
              aria-invalid={Boolean(errors.port) || undefined}
              aria-describedby={errors.port ? 'device-port-error' : undefined}
              onChange={(event) => set('port', event.target.value)}
            />
            {errors.port && (
              <p id="device-port-error" role="alert" className="text-sm text-destructive">
                {errors.port}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="device-host">Address</Label>
          <Input
            id="device-host"
            value={form.host}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.host) || undefined}
            aria-describedby={errors.host ? 'device-host-error' : 'device-host-help'}
            onChange={(event) => set('host', event.target.value)}
          />
          {errors.host ? (
            <p id="device-host-error" role="alert" className="text-sm text-destructive">
              {errors.host}
            </p>
          ) : (
            <p id="device-host-help" className="text-xs text-muted-foreground">
              A private LAN address or 127.0.0.1. hassmic listens on 26053 by default.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="device-key">API key</Label>
          <Input
            id="device-key"
            type="password"
            autoComplete="new-password"
            placeholder={device.hasKey ? 'Stored: enter a new key to replace it' : 'No key: plaintext link'}
            value={form.apiKey}
            disabled={removeKey}
            aria-invalid={Boolean(errors.apiKey) || undefined}
            aria-describedby={errors.apiKey ? 'device-key-error' : 'device-key-help'}
            onChange={(event) => set('apiKey', event.target.value)}
          />
          {errors.apiKey && (
            <p id="device-key-error" role="alert" className="text-sm text-destructive">
              {errors.apiKey}
            </p>
          )}
          <p id="device-key-help" className="text-xs text-muted-foreground">
            The key is never shown again, only whether one is stored. Empty keeps the stored key.
          </p>
          {device.hasKey &&
            (removeKey ? (
              <p className="text-sm font-medium text-destructive">
                The key will be removed (plaintext link).{' '}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setRemoveKey(false)}
                >
                  Keep it
                </button>
              </p>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => setRemoveKey(true)}>
                Remove key
              </Button>
            ))}
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-3">
          <div>
            <Label htmlFor="device-enabled" className="text-sm">
              Enabled
            </Label>
            <p className="text-xs text-muted-foreground">
              Off closes the link, so another client (a dev server) can use this Echo.
            </p>
          </div>
          <Switch
            id="device-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => set('enabled', checked)}
          />
        </div>

        <Alert>
          <AlertTitle>This may restart the link</AlertTitle>
          <AlertDescription>
            Saving a new address, port, key or enabled state drops and reopens the connection. Name, kind and
            prompt changes apply without a reconnect.
          </AlertDescription>
        </Alert>

        <div className="flex gap-2">
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? (restarting ? 'Reconnecting…' : 'Saving…') : 'Save connection'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending}
            onClick={() => {
              setForm(formOf(device));
              setRemoveKey(false);
              setErrors({});
            }}
          >
            Discard
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Whether the pending edits make the manager replace the runtime (the UI says so). */
function changesWouldRestart(form: Form, device: DeviceStatus, removeKey: boolean): boolean {
  return (
    form.host.trim() !== device.host ||
    Number(form.port) !== device.port ||
    form.enabled !== device.enabled ||
    removeKey ||
    form.apiKey.trim() !== ''
  );
}
