import type { DeviceStatus } from '@cortecho/shared';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useDeleteDevice } from '../api/devices.mutations.ts';

/** The danger zone: removing an Echo stops its link and keeps its turns (deviceId null). */
export function DeleteTab({ device }: { device: DeviceStatus }) {
  const deleteDevice = useDeleteDevice();
  const navigate = useNavigate();

  function remove() {
    deleteDevice.mutate(device.id, {
      onSuccess: () => {
        toast.success(`Removed ${device.name}.`);
        void navigate({ to: '/echos' });
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <section
      aria-label="Delete this Echo"
      className="space-y-3 rounded-xl border border-destructive/40 bg-card p-4 shadow-xs"
    >
      <h2 className="text-base font-semibold text-destructive">Danger zone</h2>
      <p className="text-sm text-muted-foreground">
        Removing this Echo closes its link and its settings overrides. Its turns stay in the history without
        an Echo. The Echo stays secured with this key. To add it again, remove the key on the Echo. This
        cannot be undone.
      </p>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={deleteDevice.isPending}>
            Delete this Echo
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {device.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The link closes now. The Echo stays secured with this key. To add it again, remove the key on
              the Echo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove} disabled={deleteDevice.isPending}>
              {deleteDevice.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
