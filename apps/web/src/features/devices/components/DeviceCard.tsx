import type { DeviceStatus } from '@cortecho/shared';
import { Link } from '@tanstack/react-router';
import { KeyRoundIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import {
  CONNECTION_LABELS,
  ENCRYPTION_LABELS,
  formatTime,
  PIPELINE_LABELS,
  PROBLEM_LABELS,
} from '@/lib/displays.ts';

const CONNECTION_TONE = {
  connected: 'good',
  connecting: 'warn',
  disconnected: 'bad',
  disabled: 'off',
} as const;

/** One Echo on the Echos page: what it is, how it is doing, and the way in. */
export function DeviceCard({ device }: { device: DeviceStatus }) {
  return (
    <section aria-label={device.name} className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          <Link
            to="/echos/$id"
            params={{ id: String(device.id) }}
            search={{ tab: 'overview' }}
            className="underline-offset-4 hover:underline"
          >
            {device.name}
          </Link>
        </h2>
        {device.kind === 'test' && <Badge variant="outline">test device</Badge>}
      </div>

      <p className="text-sm">
        <StatusDot tone={CONNECTION_TONE[device.state]}>{CONNECTION_LABELS[device.state]}</StatusDot>
        {' · '}
        <span className="text-muted-foreground">{ENCRYPTION_LABELS[device.encryption]}</span>
        {' · '}
        <span className="text-muted-foreground">{PIPELINE_LABELS[device.pipeline.state]}</span>
      </p>

      {device.problem && (
        <p className="text-sm font-medium text-destructive">{PROBLEM_LABELS[device.problem]}</p>
      )}

      <p className="font-mono text-xs text-muted-foreground">
        {device.host}:{device.port}
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt className="inline-flex items-center gap-1">
          <KeyRoundIcon aria-hidden="true" className="size-3" /> API key
        </dt>
        <dd className="text-right font-medium text-foreground">{device.hasKey ? 'set' : 'none'}</dd>
        <dt>Clock sent</dt>
        <dd className="text-right text-foreground">
          {device.lastTimeSyncAt ? formatTime(device.lastTimeSyncAt) : '–'}
        </dd>
        <dt className="inline-flex items-center gap-1">
          <SlidersHorizontalIcon aria-hidden="true" className="size-3" /> Own settings
        </dt>
        <dd className="text-right text-foreground">
          {device.overrideCount === 1 ? '1 override' : `${device.overrideCount} overrides`}
        </dd>
      </dl>

      <Link
        to="/echos/$id"
        params={{ id: String(device.id) }}
        search={{ tab: 'overview' }}
        className="mt-1 inline-flex min-h-9 w-fit items-center text-sm font-medium underline underline-offset-4"
        aria-label={`Open ${device.name}`}
      >
        Open
      </Link>
    </section>
  );
}
