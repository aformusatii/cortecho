import { useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { healthQueryOptions, turnsQueryOptions } from '../api/status.queries.ts';
import { DiagnosticsCard } from '../components/DiagnosticsCard.tsx';
import { HealthCards } from '../components/HealthCards.tsx';
import { TryItPanel } from '../components/TryItPanel.tsx';
import { TurnsList } from '../components/TurnsList.tsx';

const TURNS_SHOWN = 20;

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <AlertTriangleIcon aria-hidden="true" className="size-6 text-destructive" />
      <p className="font-medium">Could not load the status</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function StatusPage() {
  const health = useQuery(healthQueryOptions());
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const turns = useQuery(turnsQueryOptions(TURNS_SHOWN, deviceId));
  const devices = health.data?.devices ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Status</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every Echo's connection, the voice pipeline and the latest turns. Refreshes every few seconds.
        </p>
      </div>

      {health.isPending ? (
        <div role="status" aria-busy="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <span className="sr-only">Loading status…</span>
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : health.isError && !health.data ? (
        <section className="rounded-xl border bg-card shadow-xs">
          <LoadError message={health.error.message} onRetry={() => health.refetch()} />
        </section>
      ) : (
        health.data && <HealthCards health={health.data} />
      )}

      <TryItPanel devices={devices} />

      <DiagnosticsCard />

      <section aria-label="Latest turns" className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="font-semibold">Latest turns</h2>
          <div className="flex items-center gap-2">
            <label htmlFor="turns-device" className="text-xs text-muted-foreground">
              Echo
            </label>
            <select
              id="turns-device"
              value={deviceId === null ? 'all' : String(deviceId)}
              onChange={(event) =>
                setDeviceId(event.target.value === 'all' ? null : Number(event.target.value))
              }
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="all">All Echos</option>
              {devices.map((device) => (
                <option key={device.id} value={String(device.id)}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {turns.isPending ? (
          <div role="status" aria-busy="true" className="space-y-3 p-4">
            <span className="sr-only">Loading turns…</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : turns.isError && !turns.data ? (
          <LoadError message={turns.error.message} onRetry={() => turns.refetch()} />
        ) : (
          <TurnsList turns={turns.data ?? []} />
        )}
      </section>
    </div>
  );
}
