import {
  type DeviceStatus,
  SETTING_BY_KEY,
  type SettingsChange,
  type SettingsDocument,
} from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatSettingValue, formatTime } from '@/lib/displays.ts';
import { useRevertSettingsChange } from '../api/settings.mutations.ts';
import { settingsChangesQueryOptions } from '../api/settings.queries.ts';

const HISTORY_LIMIT = 100;

/**
 * The settings history: every saved change, newest first, with scope, key,
 * old → new, version, and Revert. A secret's values are never stored, so a
 * secret row only says "changed" and has no Revert (there is nothing to put back).
 */
export function SettingsHistoryDialog({
  open,
  onOpenChange,
  devices,
  onReverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: DeviceStatus[];
  /** Lets the open form adopt the document the revert produced. */
  onReverted?: (document: SettingsDocument) => void;
}) {
  const [scope, setScope] = useState<string>('all');
  const changes = useQuery(settingsChangesQueryOptions(HISTORY_LIMIT, scope === 'all' ? null : scope, open));
  const revert = useRevertSettingsChange();

  function handleRevert(change: SettingsChange) {
    const label = SETTING_BY_KEY.get(change.key)?.label ?? change.key;
    revert.mutate(change, {
      onSuccess: (document) => {
        toast.success(`Reverted ${label}.`);
        onReverted?.(document);
        void changes.refetch();
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings history</DialogTitle>
          <DialogDescription>
            {`The latest ${HISTORY_LIMIT} saved changes, newest first. Reverting writes the old value back as a new change.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <label htmlFor="history-scope" className="text-sm font-medium">
            Scope
          </label>
          <select
            id="history-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="all">All</option>
            <option value="global">Global</option>
            {devices.map((device) => (
              <option key={device.id} value={`device:${device.id}`}>
                {device.name}
              </option>
            ))}
          </select>
        </div>

        {changes.isPending ? (
          <div role="status" aria-busy="true" className="space-y-2">
            <span className="sr-only">Loading the history…</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
          </div>
        ) : changes.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load the history: {changes.error.message}
          </p>
        ) : (changes.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No changes yet.</p>
        ) : (
          <ul className="max-h-[55dvh] divide-y overflow-y-auto rounded-lg border">
            {changes.data?.map((change) => (
              <HistoryRow
                key={change.id}
                change={change}
                deviceName={deviceName(change.scope, devices)}
                reverting={revert.isPending}
                onRevert={() => handleRevert(change)}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryRow({
  change,
  deviceName: name,
  reverting,
  onRevert,
}: {
  change: SettingsChange;
  deviceName: string;
  reverting: boolean;
  onRevert: () => void;
}) {
  const descriptor = SETTING_BY_KEY.get(change.key);
  const label = descriptor?.label ?? change.key;
  const scope = change.scope === 'global' ? 'Global' : name;
  const scopeKind = change.scope === 'global' ? 'global' : 'device';

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {label} <span className="font-normal text-muted-foreground">{change.key}</span>
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {descriptor?.secret
            ? 'key changed (values are never stored)'
            : `${formatSettingValue(change.oldValue, scopeKind)} → ${formatSettingValue(change.newValue, scopeKind)}`}
        </p>
        <p className="text-xs text-muted-foreground">
          {scope} · {formatTime(change.at)} · v{change.version}
        </p>
      </div>
      {!descriptor?.secret && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={reverting}
          onClick={onRevert}
          aria-label={`Revert ${label}`}
        >
          <RotateCcwIcon aria-hidden="true" /> Revert
        </Button>
      )}
    </li>
  );
}

function deviceName(scope: string, devices: DeviceStatus[]): string {
  const id = Number(/^device:(\d+)$/.exec(scope)?.[1]);
  return devices.find((device) => device.id === id)?.name ?? 'Deleted Echo';
}
