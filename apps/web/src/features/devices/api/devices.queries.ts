import type { DeviceSettingsDocument, DeviceStatus, InstructionsDocument, Turn } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// ['devices'] is the list; ['devices', id] is that Echo's settings, prompt
// layers and turns. Saving anything invalidates both namespaces.

export const devicesKeys = {
  all: ['devices'] as const,
  list: ['devices', 'list'] as const,
  detail: (id: number) => ['devices', id] as const,
  settings: (id: number) => ['devices', id, 'settings'] as const,
  instructions: (id: number) => ['devices', id, 'instructions'] as const,
  turns: (id: number, limit: number) => ['devices', id, 'turns', limit] as const,
};

/** The Echos are live objects: the cards show connection changes within seconds. */
const POLL_MS = 5000;

export function devicesQueryOptions(refetchInterval: number = POLL_MS) {
  return queryOptions({
    queryKey: devicesKeys.list,
    queryFn: ({ signal }) => apiRequest<DeviceStatus[]>('/api/devices', { signal }),
    refetchInterval,
    staleTime: 0,
  });
}

export function deviceSettingsQueryOptions(id: number) {
  return queryOptions({
    queryKey: devicesKeys.settings(id),
    queryFn: ({ signal }) => apiRequest<DeviceSettingsDocument>(`/api/devices/${id}/settings`, { signal }),
  });
}

/** The exact prompt layers this Echo's next request will send. */
export function deviceInstructionsQueryOptions(id: number, enabled: boolean) {
  return queryOptions({
    queryKey: devicesKeys.instructions(id),
    queryFn: ({ signal }) => apiRequest<InstructionsDocument>(`/api/devices/${id}/instructions`, { signal }),
    enabled,
    staleTime: 0,
  });
}

export function deviceTurnsQueryOptions(id: number, limit: number, refetchInterval = POLL_MS) {
  return queryOptions({
    queryKey: devicesKeys.turns(id, limit),
    queryFn: ({ signal }) => apiRequest<Turn[]>(`/api/turns?limit=${limit}&deviceId=${id}`, { signal }),
    refetchInterval,
    staleTime: 0,
  });
}
