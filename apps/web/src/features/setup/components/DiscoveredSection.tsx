import type { DiscoveredEcho } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { Loader2Icon, RotateCwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useIgnoreEcho, useScanDiscovery, useUnignoreEcho } from '../api/discovery.mutations.ts';
import { discoveryQueryOptions } from '../api/discovery.queries.ts';

/**
 * The Discovered section of the Echos page (spec §5.3): Echos on the network
 * that are not added yet, with Add and Ignore, and the ignored ones behind a
 * count so "Stop ignoring" is reachable.
 */
export function DiscoveredSection({ onAdd }: { onAdd: (echo: DiscoveredEcho) => void }) {
  const discovery = useQuery(discoveryQueryOptions());
  const scan = useScanDiscovery();
  const ignore = useIgnoreEcho();
  const unignore = useUnignoreEcho();
  const [showIgnored, setShowIgnored] = useState(false);

  const found = discovery.data?.found ?? [];
  const fresh = found.filter((echo) => !echo.addedAs && !echo.ignored);
  const ignored = found.filter((echo) => !echo.addedAs && echo.ignored);
  const scanning = discovery.data?.scanning ?? false;

  if (fresh.length === 0 && ignored.length === 0) return null;

  return (
    <section aria-label="Discovered" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Discovered</h2>
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => scan.mutate()}>
          <RotateCwIcon aria-hidden="true" /> Search again
        </Button>
      </div>

      {scanning && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          Searching your network…
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fresh.map((echo) => (
          <section
            key={echo.mac}
            aria-label={echo.friendlyName}
            className="rounded-xl border bg-card p-4 shadow-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold">{echo.friendlyName}</h3>
              <Badge variant="outline">New</Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{echo.host}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" onClick={() => onAdd(echo)}>
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={ignore.isPending}
                onClick={() =>
                  ignore.mutate(echo.mac, {
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                Ignore
              </Button>
            </div>
          </section>
        ))}
      </div>

      {ignored.length > 0 &&
        (showIgnored ? (
          <div className="space-y-2">
            {ignored.map((echo) => (
              <div key={echo.mac} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">
                <span>
                  <span className="font-medium">{echo.friendlyName}</span>
                  <span className="text-muted-foreground"> · {echo.host} · Ignored</span>
                </span>
                <Button
                  type="button"
                  variant="link"
                  className="ml-auto"
                  disabled={unignore.isPending}
                  onClick={() =>
                    unignore.mutate(echo.mac, { onError: (error) => toast.error(error.message) })
                  }
                >
                  Stop ignoring
                </Button>
              </div>
            ))}
            <Button type="button" variant="link" onClick={() => setShowIgnored(false)}>
              Hide ignored
            </Button>
          </div>
        ) : (
          <Button type="button" variant="link" onClick={() => setShowIgnored(true)}>
            Show ignored ({ignored.length})
          </Button>
        ))}
    </section>
  );
}
