import { WifiOffIcon } from 'lucide-react';
import { useOnlineStatus } from '@/lib/use-online-status.ts';

/** Disabled buttons point here with aria-describedby, so screen readers hear why. */
export const OFFLINE_MESSAGE_ID = 'offline-message';

export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div role="status" className="border-b border-signal/40 bg-signal/15 text-ink">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-3 text-sm sm:px-6">
        <WifiOffIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p id={OFFLINE_MESSAGE_ID}>
          <span className="font-semibold">You are offline.</span> Showing the app shell only. Speaking and
          asking are disabled until your connection is back.
        </p>
      </div>
    </div>
  );
}
