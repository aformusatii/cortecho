import type { DeviceStatus } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { EraserIcon, RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { VoiceTestPhrase } from '@/features/settings/components/VoiceTestPhrase.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import { TurnsList } from '@/features/status/components/TurnsList.tsx';
import { CONNECTION_LABELS, formatTime, PIPELINE_LABELS, PROBLEM_LABELS } from '@/lib/displays.ts';
import { useForgetConversation, useReconnectDevice } from '../api/devices.mutations.ts';
import { deviceTurnsQueryOptions } from '../api/devices.queries.ts';

const CONNECTION_TONE = {
  connected: 'good',
  connecting: 'warn',
  disconnected: 'bad',
  disabled: 'off',
} as const;

const TURNS_SHOWN = 20;

/** Live state, what the Echo reported, the latest turns, and the two test actions. */
export function OverviewTab({ device }: { device: DeviceStatus }) {
  const turns = useQuery(deviceTurnsQueryOptions(device.id, TURNS_SHOWN));
  const reconnect = useReconnectDevice();
  const forget = useForgetConversation(device.id);

  return (
    <div className="space-y-4">
      <section aria-label="Live state" className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-base font-semibold">
          <StatusDot tone={CONNECTION_TONE[device.state]}>{CONNECTION_LABELS[device.state]}</StatusDot>
        </p>
        {device.problem && (
          <p className="mt-1 text-sm font-medium text-destructive">{PROBLEM_LABELS[device.problem]}</p>
        )}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Doing">{PIPELINE_LABELS[device.pipeline.state]}</Row>
          <Row label="Address">{`${device.host}:${device.port}`}</Row>
          <Row label="Node name">{device.nodeName ?? '–'}</Row>
          <Row label="Echo name">{device.info?.friendlyName || device.info?.name || '–'}</Row>
          <Row label="hassmic">{device.info?.version ?? '–'}</Row>
          <Row label="Model">{device.info?.model ?? '–'}</Row>
          <Row label="Features">
            {device.info
              ? [
                  device.info.supportsAnnounce ? 'announcements' : null,
                  device.info.supportsFollowUp ? 'follow-ups' : null,
                ]
                  .filter(Boolean)
                  .join(', ') || '–'
              : '–'}
          </Row>
          <Row label="Connected since">{device.connectedSince ? formatTime(device.connectedSince) : '–'}</Row>
          <Row label="Clock sent">{device.lastTimeSyncAt ? formatTime(device.lastTimeSyncAt) : '–'}</Row>
          <Row label="Reconnects">{device.reconnects}</Row>
        </dl>
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={reconnect.isPending || !device.enabled}
          onClick={() =>
            reconnect.mutate(device.id, {
              onSuccess: () => toast.success('Reconnecting…'),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <RefreshCwIcon aria-hidden="true" /> {reconnect.isPending ? 'Reconnecting…' : 'Reconnect'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="mt-4 ml-2"
          disabled={forget.isPending || !device.hasSession}
          onClick={() =>
            forget.mutate(undefined, {
              onSuccess: () => toast.success('Conversation forgotten.'),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <EraserIcon aria-hidden="true" /> {forget.isPending ? 'Forgetting…' : 'Forget conversation'}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Use this after changing the key on the Echo with <code>npm run echo-set-key</code>.
        </p>
      </section>

      <section aria-label="Test phrase" className="rounded-xl border bg-card p-4 shadow-xs">
        <h2 className="font-semibold">Play a test phrase</h2>
        <div className="mt-2">
          <VoiceTestPhrase
            devices={[device]}
            deviceId={device.id}
            description="Speaks one phrase on this Echo. It saves nothing and needs OpenAI to be configured."
          />
        </div>
      </section>

      <section aria-label="Latest turns" className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <h2 className="border-b px-4 py-3 font-semibold">Latest turns on this Echo</h2>
        {turns.isPending ? (
          <div role="status" aria-busy="true" className="space-y-3 p-4">
            <span className="sr-only">Loading turns…</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : turns.isError ? (
          <p role="alert" className="px-4 py-6 text-sm text-destructive">
            Could not load the turns: {turns.error.message}
          </p>
        ) : (
          <TurnsList turns={turns.data ?? []} />
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-dashed py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}
