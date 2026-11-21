import type { SetupDocument } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// ['setup'] is the first-launch state: the `/` redirect, the status banner and
// the onboarding's skip logic read it. Every device write and every setup
// mutation invalidates it.

export const setupKeys = {
  all: ['setup'] as const,
};

export function setupQueryOptions() {
  return queryOptions({
    queryKey: setupKeys.all,
    queryFn: ({ signal }) => apiRequest<SetupDocument>('/api/setup', { signal }),
    staleTime: 0,
    // A failed read (offline, a restarting server) must not hold the status
    // page back: the caller renders it and simply does not redirect.
    retry: false,
  });
}
