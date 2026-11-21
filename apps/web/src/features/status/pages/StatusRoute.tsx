import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { setupQueryOptions } from '@/features/setup/api/setup.queries.ts';
import { shouldRedirectToSetup } from '@/features/setup/first-launch.ts';
import { StatusPage } from '@/features/status/pages/StatusPage.tsx';
import { useOnlineStatus } from '@/lib/use-online-status.ts';

/**
 * `/` with the first-launch rule of spec §8.3: an install that never finished
 * the onboarding and has no Echo yet goes to `/setup`. The check waits for the
 * document so the status page never flashes first; a failed read renders the
 * status page rather than trapping the owner in the wizard.
 */
export function StatusRoute() {
  const setup = useQuery(setupQueryOptions());
  const online = useOnlineStatus();

  // Offline the wizard cannot run and the document cannot be read: the status
  // page (with its offline banner) is the only useful answer, and waiting on a
  // request that cannot complete would leave it on a skeleton.
  if (!online) return <StatusPage />;

  if (setup.isPending) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (setup.data && shouldRedirectToSetup(setup.data)) {
    return <Navigate to="/setup" replace />;
  }

  return <StatusPage />;
}
