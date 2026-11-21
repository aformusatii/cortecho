import type { DeviceStatus } from '@cortecho/shared';
import { Volume2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { useTestSound } from '@/features/devices/api/devices.mutations.ts';

/**
 * Settings → Network (spec §5.5): play the bundled chime on one Echo and say
 * whether it downloaded and played it. This is the same check Step 3 uses.
 */
export function TestSoundButton({ devices }: { devices: readonly DeviceStatus[] }) {
  const playable = devices.filter((device) => device.enabled);
  const [target, setTarget] = useState<string>('');
  const sound = useTestSound();
  const chosen = target !== '' ? Number(target) : playable[0]?.id;

  if (playable.length === 0) {
    return <p className="text-sm text-muted-foreground">No Echo is enabled to play the sound on.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Plays a short sound from this computer, so you can check the address above works before you rely on
        it.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {playable.length > 1 && (
          <div className="space-y-1.5">
            <label htmlFor="test-sound-target" className="text-sm font-medium">
              Play on
            </label>
            <select
              id="test-sound-target"
              value={target === '' ? String(playable[0]?.id) : target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-56"
            >
              {playable.map((device) => (
                <option key={device.id} value={String(device.id)}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={sound.isPending || chosen === undefined}
          onClick={() => {
            if (chosen === undefined) return;
            sound.mutate(chosen, {
              onError: (error) => toast.error(error.message),
            });
          }}
        >
          <Volume2Icon aria-hidden="true" /> {sound.isPending ? 'Playing…' : 'Play a test sound'}
        </Button>
      </div>
      <div aria-live="polite" className="text-sm">
        {sound.isPending && <p className="text-muted-foreground">Playing the sound…</p>}
        {sound.data && (
          <p className={sound.data.downloaded ? 'font-medium' : 'text-destructive'}>
            {!sound.data.downloaded
              ? 'The Echo did not download the sound. Check the reply address above.'
              : sound.data.finished
                ? 'Downloaded and played.'
                : 'Downloaded, but the Echo did not confirm playing it.'}
          </p>
        )}
      </div>
    </div>
  );
}
