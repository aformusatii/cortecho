import type {
  DeviceCreate,
  DeviceSettingsDocument,
  DeviceSettingsPatch,
  DeviceStatus,
  DeviceUpdate,
} from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';
import { devicesKeys } from './devices.queries.ts';

// Every device write also moves the settings version (the store's counter
// covers overrides) and the status cards, so all three namespaces refresh.

function invalidateDeviceViews(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
  void queryClient.invalidateQueries({ queryKey: devicesKeys.all });
  if (id !== undefined) void queryClient.invalidateQueries({ queryKey: devicesKeys.detail(id) });
  void queryClient.invalidateQueries({ queryKey: ['settings'] });
  void queryClient.invalidateQueries({ queryKey: ['status'] });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceCreate) =>
      apiRequest<DeviceStatus>('/api/devices', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => invalidateDeviceViews(queryClient),
  });
}

export function useUpdateDevice(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceUpdate) =>
      apiRequest<DeviceStatus>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => invalidateDeviceViews(queryClient, id),
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateDeviceViews(queryClient),
  });
}

export function useReconnectDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/devices/${id}/reconnect`, { method: 'POST' }),
    onSettled: (_data, _error, id) => invalidateDeviceViews(queryClient, id),
  });
}

/** After `unexpected-device`: the owner confirms the Echo now answering at this address. */
export function useAcceptDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest<DeviceStatus>(`/api/devices/${id}/accept-device`, { method: 'POST' }),
    onSuccess: (_device, id) => invalidateDeviceViews(queryClient, id),
  });
}

/**
 * Per-Echo overrides. The same version counter as the global form, so a
 * concurrent change can 409 here too.
 */
export function useSaveDeviceSettings(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceSettingsPatch) =>
      apiRequest<DeviceSettingsDocument>(`/api/devices/${id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (document) => {
      queryClient.setQueryData(devicesKeys.settings(id), document);
      invalidateDeviceViews(queryClient, id);
    },
  });
}
