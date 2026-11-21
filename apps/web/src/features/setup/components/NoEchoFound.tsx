import { Button } from '@/components/ui/button.tsx';

/** The §5.2 checklist, shared by Step 1 and the Echos page's empty state. */
export function NoEchoFound({
  onSearchAgain,
  onEnterAddress,
}: {
  onSearchAgain: () => void;
  onEnterAddress: () => void;
}) {
  return (
    <section aria-label="No Echo found yet" className="rounded-xl border border-dashed bg-card p-4 text-sm">
      <h3 className="font-semibold">No Echo found yet</h3>
      <p className="mt-1 text-muted-foreground">Check that:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
        <li>the Echo is plugged in and its light ring is off (idle)</li>
        <li>it runs echo-dot-assist in ESPHome mode</li>
        <li>it is on the same network as this computer</li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onSearchAgain}>
          Search again
        </Button>
        <Button type="button" variant="link" onClick={onEnterAddress}>
          Enter an address instead
        </Button>
      </div>
    </section>
  );
}
