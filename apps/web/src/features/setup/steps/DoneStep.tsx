import type { DeviceStatus } from '@cortecho/shared';
import { Button } from '@/components/ui/button.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { DOC_LINKS } from '../flow.ts';

/** Step 6 (spec §5.2): what works now, and how to pair two Echos. */
export function DoneStep({
  device,
  other,
  doneLabel,
  onDone,
  onOpen,
}: {
  device: DeviceStatus;
  /** The first other Echo, when there are two or more. */
  other: DeviceStatus | null;
  doneLabel: string;
  onDone: () => void;
  onOpen: () => void;
}) {
  const checks = [
    { label: 'Connected', ok: device.state === 'connected' },
    { label: 'Secured', ok: device.encryption === 'noise' },
    { label: 'Clock set', ok: device.lastTimeSyncAt !== null },
  ];

  return (
    <div className="space-y-4">
      <StepHeading>{`${device.name} is ready`}</StepHeading>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {checks.map((check) => (
          <li key={check.label} className={check.ok ? 'font-medium' : 'text-muted-foreground'}>
            {check.ok ? '✓' : '○'} {check.label}
          </li>
        ))}
      </ul>

      {other && (
        <section
          aria-label="Pairing"
          className="rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <p>
            <strong className="text-foreground">Pair it with your other Echos</strong> so only the nearest one
            answers: hold <strong className="text-foreground">Volume up + Volume down</strong> for 2 seconds
            on {device.name}, then on {other.name}.
          </p>
          <a
            href={DOC_LINKS.pairing}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Learn more ↗
          </a>
        </section>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onOpen}>
          {`Open ${device.name}'s settings`}
        </Button>
        <Button type="button" onClick={onDone} className="w-full sm:w-auto">
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
