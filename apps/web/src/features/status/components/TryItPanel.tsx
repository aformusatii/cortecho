import { type DeviceStatus, MAX_TEXT_LENGTH, type SayResult } from '@cortecho/shared';
import { MessageSquareIcon, Volume2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { OFFLINE_MESSAGE_ID } from '@/components/OfflineBanner.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import { useAsk, useSay } from '@/features/voice/api.ts';
import { useOnlineStatus } from '@/lib/use-online-status.ts';

/**
 * Test the agent without talking ("Ask", against an Echo's memory or the web
 * session) and make Echos speak ("Say", one or all). Say reports each Echo
 * separately, so one busy or offline Echo never hides the others' result.
 */
export function TryItPanel({ devices }: { devices: DeviceStatus[] }) {
  const [text, setText] = useState('');
  const [lastReply, setLastReply] = useState<string | null>(null);
  const [askTarget, setAskTarget] = useState('web');
  const [sayTarget, setSayTarget] = useState('all');
  const [sayResults, setSayResults] = useState<SayResult[] | null>(null);
  const isOnline = useOnlineStatus();
  const ask = useAsk();
  const say = useSay();
  const busy = ask.isPending || say.isPending;
  const trimmed = text.trim();

  const echoDevices = devices.filter((device) => device.enabled && device.kind === 'echo');
  const selectedSay =
    sayTarget === 'all' ? null : (devices.find((device) => String(device.id) === sayTarget) ?? null);
  const sayAllowed = selectedSay
    ? selectedSay.enabled
    : echoDevices.some((device) => device.state === 'connected');

  function handleAsk(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed) return;
    ask.mutate(
      { text: trimmed, ...(askTarget === 'web' ? {} : { deviceId: Number(askTarget) }) },
      {
        onSuccess: ({ turn }) => setLastReply(turn.reply),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function handleSay() {
    if (!trimmed) return;
    setSayResults(null);
    say.mutate(
      {
        text: trimmed,
        ...(selectedSay ? { deviceId: selectedSay.id } : { all: true }),
      },
      {
        onSuccess: ({ results }) => {
          setSayResults(results);
          if (results.length === 0) {
            toast.error('No Echo is enabled.');
            return;
          }
          const spoken = results.filter((result) => result.ok);
          const failed = results.filter((result) => !result.ok);
          if (failed.length === 0) toast.success(`Spoken on ${spoken.map((r) => r.deviceName).join(', ')}.`);
          else
            toast.warning(
              `Spoken on ${spoken.length} of ${results.length}. ` +
                failed
                  .map((result) => `${result.deviceName}: ${result.error?.message ?? 'failed'}`)
                  .join(' '),
            );
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <section aria-label="Try it" className="rounded-xl border bg-card p-4 shadow-xs">
      <form onSubmit={handleAsk} className="space-y-3">
        <Label htmlFor="try-text">Ask the agent, or make the Echos say something</Label>
        <Input
          id="try-text"
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(event) => setText(event.target.value)}
          placeholder="What time is it?"
          autoComplete="off"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ask-target" className="text-xs text-muted-foreground">
              Ask on
            </Label>
            <select
              id="ask-target"
              value={askTarget}
              onChange={(event) => setAskTarget(event.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="web">Web (text only)</option>
              {devices.map((device) => (
                <option key={device.id} value={String(device.id)}>
                  {device.name} (its memory and prompt)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="say-target" className="text-xs text-muted-foreground">
              Say on
            </Label>
            <select
              id="say-target"
              value={sayTarget}
              onChange={(event) => setSayTarget(event.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="all">All Echos</option>
              {devices.map((device) => (
                <option key={device.id} value={String(device.id)}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="submit"
            disabled={!isOnline || busy || !trimmed}
            aria-describedby={isOnline ? undefined : OFFLINE_MESSAGE_ID}
          >
            <MessageSquareIcon aria-hidden="true" /> {ask.isPending ? 'Asking…' : 'Ask (text reply)'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleSay}
            disabled={!isOnline || busy || !trimmed || !sayAllowed}
            title={sayAllowed ? undefined : 'No Echo is connected'}
          >
            <Volume2Icon aria-hidden="true" />{' '}
            {say.isPending ? 'Speaking…' : selectedSay ? `Say on ${selectedSay.name}` : 'Say on all Echos'}
          </Button>
        </div>
      </form>

      {lastReply !== null && (
        <p
          aria-live="polite"
          className="mt-4 rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
        >
          {lastReply || '(empty reply)'}
        </p>
      )}

      {sayResults && sayResults.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Say result</h3>
          <ul aria-label="Say results" className="mt-1 space-y-1 text-sm">
            {sayResults.map((result) => (
              <li key={result.deviceId}>
                <StatusDot tone={result.ok ? 'good' : 'bad'}>
                  {result.deviceName}: {result.ok ? 'spoken' : (result.error?.message ?? 'failed')}
                </StatusDot>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
