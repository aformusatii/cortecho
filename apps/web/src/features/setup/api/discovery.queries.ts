import type { DiscoveryDocument } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// ['discovery'] is the in-memory network picture the setup wizard reads. A scan
// runs in the background, so while one is running the document is polled fast;
// between scans it only needs to catch an mDNS sighting.

export const discoveryKeys = {
  all: ['discovery'] as const,
};

const SCANNING_POLL_MS = 1000;
const IDLE_POLL_MS = 15_000;

export function discoveryQueryOptions() {
  return queryOptions({
    queryKey: discoveryKeys.all,
    queryFn: ({ signal }) => apiRequest<DiscoveryDocument>('/api/discovery', { signal }),
    refetchInterval: (query) => (query.state.data?.scanning ? SCANNING_POLL_MS : IDLE_POLL_MS),
    staleTime: 0,
  });
}

/** The badge and the "Discovered" section count: found, not added, not ignored. */
export function newEchoCount(document: DiscoveryDocument | undefined): number {
  return (document?.found ?? []).filter((echo) => !echo.addedAs && !echo.ignored).length;
}
