import type { DiscoveredEcho } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { useUpdateDevice } from '@/features/devices/api/devices.mutations.ts';
import { discoveryQueryOptions } from '../api/discovery.queries.ts';

/**
 * A moved Echo (spec §7.7): discovery sees this device's MAC at another
 * address while its link is down (usually DHCP changed it). The stored key
 * proves the identity, so the one click is a PATCH of host and port; the link
 * restarts at the new address.
 */
export function MovedEchoRepairs() {
  const discovery = useQuery(discoveryQueryOptions());
  const moved = (discovery.data?.found ?? []).filter((echo) => echo.movedFrom !== null);

  if (moved.length === 0) return null;

  return (
    <section aria-label="Moved Echos" className="space-y-2 rounded-xl border bg-card p-4 shadow-xs">
      <h2 className="font-semibold">An Echo changed its address</h2>
      {moved.map((echo) => (
        <MovedRow key={echo.mac} echo={echo} />
      ))}
    </section>
  );
}

function MovedRow({ echo }: { echo: DiscoveredEcho }) {
  const moved = echo.movedFrom;
  const update = useUpdateDevice(moved?.id ?? 0);

  if (!moved) return null;

  return (
    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p>
        <span className="font-medium">{moved.name}</span> moved to {echo.host}:{echo.port}.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={update.isPending}
        onClick={() =>
          update.mutate(
            { host: echo.host, port: echo.port },
            {
              onSuccess: () => toast.success(`${moved.name} now uses ${echo.host}:${echo.port}.`),
              onError: (error) => toast.error(error.message),
            },
          )
        }
      >
        Use the new address
      </Button>
    </div>
  );
}
