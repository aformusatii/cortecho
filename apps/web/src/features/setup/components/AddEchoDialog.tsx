import type { DiscoveredEcho } from '@cortecho/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { AddEchoFlow } from './AddEchoFlow.tsx';

/**
 * The Add Echo flow in a dialog (spec §4): a full-screen sheet below `sm`, a
 * centered card above it. Closing stays possible after an Echo was adopted —
 * the row is already in the database, so closing never undoes the key step.
 * The sheet is full height and the dialog is a grid, so without
 * `max-sm:content-start` both rows stretch and the step floats below the
 * title; the content stays top-aligned, as in the desktop dialog.
 */
export function AddEchoDialog({
  open,
  onOpenChange,
  initialTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTarget?: DiscoveredEcho | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-none max-sm:content-start"
        data-testid="add-echo-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add Echo</DialogTitle>
          <DialogDescription className="sr-only">
            Connect an Echo to Cortecho and give it a name.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <AddEchoFlow
            key={initialTarget?.mac ?? 'manual'}
            initialTarget={initialTarget}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
