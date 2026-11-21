import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { setupQueryOptions } from '../api/setup.queries.ts';

/**
 * The reminder after "Skip for now" (spec §4): it stays on the status page
 * until an Echo exists. The redirect cannot be the only reminder, because the
 * skip would then be undone by the next visit to `/`.
 */
export function SetupBanner() {
  const setup = useQuery(setupQueryOptions());

  if (!setup.data || setup.data.onboardingDone || setup.data.hasEcho) return null;

  return (
    <Alert>
      <AlertTitle>Cortecho is not set up yet.</AlertTitle>
      <AlertDescription>
        <span className="mt-2 inline-flex">
          <Button asChild size="sm" variant="outline">
            <Link to="/setup">Continue setup</Link>
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
