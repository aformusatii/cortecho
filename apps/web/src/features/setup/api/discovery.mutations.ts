import type { DiscoveryDocument } from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiRequest } from '@/lib/api-client.ts';
import { discoveryKeys } from './discovery.queries.ts';

function invalidateDiscovery(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: discoveryKeys.all });
}

/**
 * Asks the server for a scan. The UI sends the host it was opened with, which
 * the server turns into its /24 (spec §6.1.2); the answer is 202 with the
 * current document, so the scanning state changes immediately either way.
 */
export function useScanDiscovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const host = window.location.hostname;
      return apiRequest<DiscoveryDocument>('/api/discovery/scan', {
        method: 'POST',
        body: JSON.stringify({ hints: host ? [host] : [] }),
      });
    },
    onSuccess: (document) => {
      queryClient.setQueryData(discoveryKeys.all, document);
      invalidateDiscovery(queryClient);
    },
  });
}

/**
 * One scan when a setup surface opens (spec §6.1.2). Guarded by a ref because
 * React StrictMode runs the effect twice in development; the server also
 * rate-limits a scan to once per minute.
 */
export function useScanOnOpen(enabled = true): void {
  const { mutate } = useScanDiscovery();
  const asked = useRef(false);
  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    // `mutate` is stable in TanStack Query, so this runs once per mount.
    mutate();
  }, [enabled, mutate]);
}

export function useIgnoreEcho() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mac: string) =>
      apiRequest<void>('/api/discovery/ignore', { method: 'POST', body: JSON.stringify({ mac }) }),
    onSuccess: () => {
      invalidateDiscovery(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useUnignoreEcho() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mac: string) =>
      apiRequest<void>(`/api/discovery/ignore/${encodeURIComponent(mac)}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateDiscovery(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
