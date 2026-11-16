import type { Health, Turn } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

/** Everything on the status page starts with 'status', so one invalidation refreshes it all. */
export const statusKeys = {
  all: ['status'] as const,
  health: ['status', 'health'] as const,
  turns: (limit: number, deviceId: number | null) => ['status', 'turns', limit, deviceId ?? 'all'] as const,
};

/** The page is a live monitor: poll every few seconds while it is open. */
const POLL_MS = 3000;

export function healthQueryOptions() {
  return queryOptions({
    queryKey: statusKeys.health,
    queryFn: ({ signal }) => apiRequest<Health>('/api/health', { signal }),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });
}

export function turnsQueryOptions(limit: number, deviceId: number | null = null) {
  const filter = deviceId === null ? '' : `&deviceId=${deviceId}`;
  return queryOptions({
    queryKey: statusKeys.turns(limit, deviceId),
    queryFn: ({ signal }) => apiRequest<Turn[]>(`/api/turns?limit=${limit}${filter}`, { signal }),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });
}
