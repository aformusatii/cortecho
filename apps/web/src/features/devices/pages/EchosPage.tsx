import type { DiscoveredEcho } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useScanDiscovery, useScanOnOpen } from '@/features/setup/api/discovery.mutations.ts';
import { discoveryQueryOptions } from '@/features/setup/api/discovery.queries.ts';
import { AddEchoDialog } from '@/features/setup/components/AddEchoDialog.tsx';
import { DiscoveredSection } from '@/features/setup/components/DiscoveredSection.tsx';
import { NoEchoFound } from '@/features/setup/components/NoEchoFound.tsx';
import { devicesQueryOptions } from '../api/devices.queries.ts';
import { DeviceCard } from '../components/DeviceCard.tsx';

/** Every Echo, with its live state, and the way to add the next one. */
export function EchosPage() {
  const devices = useQuery(devicesQueryOptions());
  const discovery = useQuery(discoveryQueryOptions());
  const scan = useScanDiscovery();
  const [addOpen, setAddOpen] = useState(false);
  const [target, setTarget] = useState<DiscoveredEcho | null>(null);
  const list = devices.data ?? [];
  const fresh = (discovery.data?.found ?? []).filter((echo) => !echo.addedAs && !echo.ignored);

  // The Echos page is a discovery surface: opening it asks for a scan (§6.1.2).
  useScanOnOpen();

  function openFlow(echo: DiscoveredEcho | null) {
    setTarget(echo);
    setAddOpen(true);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Echos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One link per Echo. Add, connect and tune each room here, with no restart.
          </p>
        </div>
        <Button onClick={() => openFlow(null)}>
          <PlusIcon aria-hidden="true" /> Add Echo
        </Button>
      </header>

      <DiscoveredSection onAdd={openFlow} />

      {devices.isPending ? (
        <div role="status" aria-busy="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <span className="sr-only">Loading the Echos…</span>
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : devices.isError && !devices.data ? (
        <section role="alert" className="rounded-xl border bg-card p-6 text-center">
          <p className="font-medium">Could not load the Echos</p>
          <p className="text-sm text-muted-foreground">{devices.error.message}</p>
          <Button variant="outline" className="mt-3" onClick={() => devices.refetch()}>
            Try again
          </Button>
        </section>
      ) : list.length === 0 ? (
        discovery.isSuccess && fresh.length === 0 ? (
          <NoEchoFound onSearchAgain={() => scan.mutate()} onEnterAddress={() => openFlow(null)} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No Echos yet. Add one from Discovered above, or use Add Echo.
          </p>
        )
      ) : (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Your Echos</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((device) => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        </section>
      )}

      <AddEchoDialog
        open={addOpen}
        initialTarget={target}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setTarget(null);
        }}
      />
    </div>
  );
}
