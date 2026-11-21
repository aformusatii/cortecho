import type {
  DeviceAdopt,
  DeviceCreate,
  DeviceProbe,
  DeviceSettingsDocument,
  DeviceSettingsPatch,
  DeviceStatus,
  DeviceUpdate,
  EchoProbeResult,
  TestSoundResult,
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
  // An adopt or delete changes `hasEcho`, which decides the first-launch state.
  void queryClient.invalidateQueries({ queryKey: ['setup'] });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceCreate) =>
      apiRequest<DeviceStatus>('/api/devices', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => invalidateDeviceViews(queryClient),
  });
}

/**
 * The setup wizard's one call for Step 2 (spec §7.4): connect, secure with a
 * key the server generates (or the owner's pasted key), and add the Echo.
 * A new Echo also changes the Discovered list.
 */
export function useAdoptEcho() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceAdopt) =>
      apiRequest<DeviceStatus>('/api/devices/adopt', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (device) => {
      invalidateDeviceViews(queryClient, device.id);
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}

/** What answers at an address before Step 2 (spec §7.3). Read-only. */
export function useProbeEcho() {
  return useMutation({
    mutationFn: (input: DeviceProbe) =>
      apiRequest<EchoProbeResult>('/api/devices/probe', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

/** "Secure now" for an existing unkeyed row (spec §5.6); refused on a keyed one. */
export function useSecureDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest<DeviceStatus>(`/api/devices/${id}/secure`, { method: 'POST' }),
    onSuccess: (_device, id) => {
      invalidateDeviceViews(queryClient, id);
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}

/** The bundled chime through the announcement path (spec §7.5). Saves nothing. */
export function useTestSound() {
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest<TestSoundResult>(`/api/devices/${id}/test-sound`, { method: 'POST' }),
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

/** "Forget conversation": drop this Echo's memory (and any pending confirm). */
export function useForgetConversation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>(`/api/devices/${id}/conversation/reset`, { method: 'POST' }),
    onSettled: () => invalidateDeviceViews(queryClient, id),
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
