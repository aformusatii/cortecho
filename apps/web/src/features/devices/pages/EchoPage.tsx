import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import { CONNECTION_LABELS, ENCRYPTION_LABELS } from '@/lib/displays.ts';
import { devicesQueryOptions } from '../api/devices.queries.ts';
import { ConnectionTab } from '../components/ConnectionTab.tsx';
import { DeleteTab } from '../components/DeleteTab.tsx';
import { EchoConnectorsTab } from '../components/EchoConnectorsTab.tsx';
import { OverviewTab } from '../components/OverviewTab.tsx';
import { PromptTab } from '../components/PromptTab.tsx';
import { TuningTab } from '../components/TuningTab.tsx';
import { ECHO_TAB_LABELS, ECHO_TABS, type EchoTab, isEchoTab } from '../tabs.ts';

const CONNECTION_TONE = {
  connected: 'good',
  connecting: 'warn',
  disconnected: 'bad',
  disabled: 'off',
} as const;

/**
 * One Echo: its live state, its connection, its prompt, its overrides and the
 * danger zone. The tab is in `?tab=`, so each is deep-linkable and the browser
 * back button works between them.
 */
export function EchoPage({ deviceId, tab }: { deviceId: number; tab: EchoTab }) {
  const devices = useQuery(devicesQueryOptions());
  const navigate = useNavigate();
  const device = devices.data?.find((candidate) => candidate.id === deviceId);

  // A deleted Echo (or a bad id) goes back to the list rather than showing a
  // stale page.
  useEffect(() => {
    if (devices.data && !device) void navigate({ to: '/echos', replace: true });
  }, [devices.data, device, navigate]);

  if (devices.isPending) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="sr-only">Loading the Echo…</span>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!device) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="font-medium">This Echo does not exist.</p>
        <Button asChild variant="outline">
          <Link to="/echos">Back to Echos</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/echos"
          className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" /> All Echos
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{device.name}</h1>
          <Badge variant="outline">{device.kind === 'test' ? 'test device' : 'Echo'}</Badge>
          <Badge variant="outline">{ENCRYPTION_LABELS[device.encryption]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <StatusDot tone={CONNECTION_TONE[device.state]}>{CONNECTION_LABELS[device.state]}</StatusDot>
          {' · '}
          <span className="font-mono">
            {device.host}:{device.port}
          </span>
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (!isEchoTab(value)) return;
          void navigate({
            to: '/echos/$id',
            params: { id: String(device.id) },
            search: { tab: value },
            replace: true,
          });
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          {ECHO_TABS.map((value) => (
            <TabsTrigger key={value} value={value} className="min-h-9 px-3">
              {ECHO_TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab device={device} />
        </TabsContent>
        <TabsContent value="connection">
          <ConnectionTab device={device} />
        </TabsContent>
        <TabsContent value="prompt">
          <PromptTab device={device} />
        </TabsContent>
        <TabsContent value="tuning">
          <TuningTab device={device} />
        </TabsContent>
        <TabsContent value="connectors">
          <EchoConnectorsTab device={device} />
        </TabsContent>
        <TabsContent value="delete">
          <DeleteTab device={device} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
