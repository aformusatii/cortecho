import type { DeviceStatus } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { connectorsQueryOptions } from '@/features/connectors/api/connectors.queries.ts';
import { isApiError } from '@/lib/api-client.ts';
import { useSaveDeviceSettings } from '../api/devices.mutations.ts';
import { deviceSettingsQueryOptions } from '../api/devices.queries.ts';

/**
 * Which connectors this Echo may use. Stored as the `connectors.disabled`
 * per-Echo override, so it follows the same version/409 flow as every other
 * override and takes effect on the Echo's next turn.
 */
export function EchoConnectorsTab({ device }: { device: DeviceStatus }) {
  const connectors = useQuery(connectorsQueryOptions());
  const document = useQuery(deviceSettingsQueryOptions(device.id));
  const save = useSaveDeviceSettings(device.id);
  const [disabled, setDisabled] = useState<string[] | null>(null);
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    if (!document.data) return;
    const key = `${document.data.version}:${JSON.stringify(document.data.overrides['connectors.disabled'] ?? [])}`;
    if (seeded.current === key) return;
    seeded.current = key;
    const value = document.data.overrides['connectors.disabled'];
    setDisabled(Array.isArray(value) ? value.map(String) : []);
  }, [document.data]);

  if (connectors.isPending || document.isPending || disabled === null) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">Loading connectors…</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const list = connectors.data ?? [];

  function toggle(slug: string, allowed: boolean) {
    if (!document.data || disabled === null) return;
    const next = allowed ? disabled.filter((item) => item !== slug) : [...new Set([...disabled, slug])];
    setDisabled(next);
    save.mutate(
      {
        version: document.data.version,
        changes: { 'connectors.disabled': next },
      },
      {
        onSuccess: () => toast.success(allowed ? 'This Echo may use it.' : 'Turned off for this Echo.'),
        onError: (error) => {
          setDisabled(disabled);
          toast.error(
            isApiError(error) && error.status === 409
              ? 'The settings changed in another tab. Reload this page and try again.'
              : error.message,
          );
        },
      },
    );
  }

  if (list.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center">
        <p className="font-medium">No connectors yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add Gmail, Calendar or any MCP server in Settings → Connectors, then choose here which ones this
          Echo may use.
        </p>
        <Button asChild variant="outline" className="mt-3">
          <Link to="/settings" search={{ tab: 'connectors' }}>
            Open Connectors
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Turn off anything this speaker should not read aloud or act on. The change applies to its next turn.
      </p>
      <ul className="divide-y rounded-xl border bg-card shadow-xs">
        {list.map((connector) => {
          const allowed = !disabled.includes(connector.slug);
          return (
            <li key={connector.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium">{connector.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {connector.toolsEnabled} of {connector.toolsTotal} tools ·{' '}
                  {connector.state.replace('_', ' ')}
                  {!connector.enabled && ' (connector is off globally)'}
                </p>
              </div>
              <Switch
                checked={allowed && connector.enabled}
                disabled={!connector.enabled || save.isPending}
                aria-label={`${device.name} may use ${connector.name}`}
                onCheckedChange={(checked) => toggle(connector.slug, checked)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
