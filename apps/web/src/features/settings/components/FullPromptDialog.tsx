import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { deviceInstructionsQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { settingsInstructionsQueryOptions } from '../api/settings.queries.ts';

/**
 * The assembled system prompt exactly as the next request sends it: the three
 * layers, labelled, then the joined text (spec §8.3). `deviceId` absent = the
 * prompt `/api/ask` without a device uses.
 */
export function FullPromptDialog({
  open,
  onOpenChange,
  deviceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId?: number;
}) {
  const global = useQuery(settingsInstructionsQueryOptions(open && deviceId === undefined));
  const device = useQuery(deviceInstructionsQueryOptions(deviceId ?? 0, open && deviceId !== undefined));
  const query = deviceId === undefined ? global : device;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Full prompt</DialogTitle>
          <DialogDescription>
            Exactly what the assistant is told on the next request: your household prompt, the built-in
            speaker rules, and this Echo's own text.
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <div role="status" aria-busy="true" className="space-y-3">
            <span className="sr-only">Loading the prompt…</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load the prompt: {query.error.message}
          </p>
        ) : (
          query.data && (
            <div className="space-y-4">
              {query.data.layers.map((layer) => (
                <section key={layer.layer} aria-label={layer.title}>
                  <h3 className="text-sm font-semibold">
                    {layer.layer === 1
                      ? '1. Household'
                      : layer.layer === 2
                        ? '2. Speaker rules'
                        : '3. This Echo'}
                    <span className="font-normal text-muted-foreground"> — {layer.title}</span>
                  </h3>
                  <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                    {layer.text.trim() === '' ? '(empty)' : layer.text}
                  </pre>
                </section>
              ))}
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
                  Joined text (as sent)
                </summary>
                <pre className="max-h-64 overflow-auto border-t p-3 text-xs whitespace-pre-wrap">
                  {query.data.text}
                </pre>
              </details>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
