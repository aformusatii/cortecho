import type { DeviceStatus, VoicePreview } from '@cortecho/shared';
import { Volume2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import { useSay } from '@/features/voice/api.ts';

const DEFAULT_PHRASE = 'This is a test of the voice.';

/**
 * "Play a test phrase": speaks the text with the values currently in the form
 * and saves nothing (POST /api/say's voice preview block). On an Echo's page
 * the Echo is fixed; on Settings a picker chooses one or all.
 */
export function VoiceTestPhrase({
  devices,
  voice,
  deviceId,
  description,
}: {
  devices: DeviceStatus[];
  /** The unsaved voice values from the form (never stored by this call). */
  voice?: VoicePreview;
  /** Fixed target: no picker. */
  deviceId?: number;
  description?: string;
}) {
  const [text, setText] = useState(DEFAULT_PHRASE);
  const [target, setTarget] = useState<string>('all');
  const say = useSay();
  const trimmed = text.trim();

  const pickable = devices.filter((device) => device.enabled && device.kind === 'echo');
  const fixed = deviceId === undefined ? null : (devices.find((device) => device.id === deviceId) ?? null);
  const choices = fixed ? [fixed] : pickable;

  function handlePlay() {
    if (!trimmed) return;
    const chosen = fixed ? fixed.id : target === 'all' ? undefined : Number(target);
    say.mutate(
      { text: trimmed, ...(chosen === undefined ? {} : { deviceId: chosen }), ...(voice ? { voice } : {}) },
      {
        onSuccess: ({ results }) => {
          if (results.length === 0) {
            toast.error('No Echo is enabled to speak on.');
            return;
          }
          const failed = results.filter((result) => !result.ok);
          if (failed.length === 0) {
            toast.success(`Played on ${results.map((result) => result.deviceName).join(', ')}.`);
          } else {
            toast.warning(
              `Played on ${results.length - failed.length} of ${results.length}. ` +
                failed
                  .map((result) => `${result.deviceName}: ${result.error?.message ?? 'failed'}`)
                  .join(' '),
            );
          }
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {description ??
          'Hear the voice with the values in this form, before saving. This plays a phrase and saves nothing.'}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="test-phrase">Phrase</Label>
          <Input
            id="test-phrase"
            value={text}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {!fixed && (
          <div className="space-y-1.5">
            <Label htmlFor="test-phrase-target">Play on</Label>
            <select
              id="test-phrase-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-56"
            >
              <option value="all">All Echos</option>
              {pickable.map((device) => (
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
          onClick={handlePlay}
          disabled={say.isPending || !trimmed || choices.length === 0}
        >
          <Volume2Icon aria-hidden="true" /> {say.isPending ? 'Playing…' : 'Play'}
        </Button>
      </div>
      {choices.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No Echo is enabled. Add one on the Echos page to hear a test phrase.
        </p>
      )}
      {say.data && say.data.results.length > 0 && (
        <ul aria-label="Test phrase results" className="space-y-1 text-sm">
          {say.data.results.map((result) => (
            <li key={result.deviceId}>
              <StatusDot tone={result.ok ? 'good' : 'bad'}>
                {result.deviceName}: {result.ok ? 'played' : (result.error?.message ?? 'failed')}
              </StatusDot>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
