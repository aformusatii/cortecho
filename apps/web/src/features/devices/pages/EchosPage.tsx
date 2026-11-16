import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { devicesQueryOptions } from '../api/devices.queries.ts';
import { AddDeviceDialog } from '../components/AddDeviceDialog.tsx';
import { DeviceCard } from '../components/DeviceCard.tsx';

const README_URL = 'https://github.com/aformusatii/cortecho/blob/main/docs/echo-setup.md#several-echos';

/** Every Echo, with its live state, and the way to add the next one. */
export function EchosPage() {
  const devices = useQuery(devicesQueryOptions());
  const [addOpen, setAddOpen] = useState(false);
  const list = devices.data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Echos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One link per Echo. Add, connect and tune each room here, with no restart.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <PlusIcon aria-hidden="true" /> Add Echo
        </Button>
      </header>

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
        <EmptyState onAdd={() => setAddOpen(true)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}

      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/** The onboarding steps from the design (§11), short enough to follow here. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section aria-label="No Echos yet" className="rounded-xl border bg-card p-5 shadow-xs sm:p-6">
      <h2 className="text-lg font-semibold">No Echos yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each Echo runs hassmic in ESPHome mode and keeps its own link. The steps, in order:
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
        <li>
          Root the Echo and install hassmic (<code>echo-dot-assist</code>). Set <code>PROTO=esphome</code> and
          a <strong>unique NAME</strong> in <code>hassmic.conf</code>, pick the wake word, and check the
          firewall (<code>lockdown.sh check</code>).
        </li>
        <li>
          Generate a key on this machine with <code>openssl rand -base64 32</code>, then give it to the Echo:{' '}
          <code>ECHO_HOST=&lt;ip&gt; ECHO_API_KEY=&lt;key&gt; npm run echo-set-key</code> (this changes the
          Echo).
        </li>
        <li>
          Add it here with its name, address and the same key. The card should show{' '}
          <em>Connected · Encrypted</em> and a clock sync within seconds.
        </li>
        <li>
          <strong>Pair it</strong> with the Echos already in place: hold Volume up + Volume down for 2 s on
          the new Echo, then on one of the others. Without pairing, every Echo that hears the wake word
          answers.
        </li>
        <li>
          Test it: say the wake word near both. Only the nearer one answers; the other's log says{' '}
          <code>answered_elsewhere</code>.
        </li>
      </ol>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={onAdd}>
          <PlusIcon aria-hidden="true" /> Add the first Echo
        </Button>
        <Button variant="outline" asChild>
          <a href={README_URL} target="_blank" rel="noopener noreferrer">
            Read “Several Echos” in the README
          </a>
        </Button>
      </div>
    </section>
  );
}
