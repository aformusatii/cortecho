import type { McpCatalogEntry, McpServerDetail, McpServerStatus } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// ['mcp'] is the whole connector namespace (catalog + list), ['mcp', 'servers', id]
// one connector. Writes invalidate ['mcp'] and ['status'] (the health card).
export const connectorKeys = {
  all: ['mcp'] as const,
  catalog: ['mcp', 'catalog'] as const,
  list: ['mcp', 'servers'] as const,
  detail: (id: number) => ['mcp', 'servers', id] as const,
};

const POLL_MS = 4000;

export function connectorCatalogQueryOptions() {
  return queryOptions({
    queryKey: connectorKeys.catalog,
    queryFn: ({ signal }) =>
      apiRequest<{ entries: McpCatalogEntry[]; secretKeyConfigured: boolean }>('/api/mcp/catalog', {
        signal,
      }),
    staleTime: 60 * 60_000,
  });
}

export function connectorsQueryOptions() {
  return queryOptions({
    queryKey: connectorKeys.list,
    queryFn: ({ signal }) => apiRequest<McpServerStatus[]>('/api/mcp/servers', { signal }),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });
}

export function connectorQueryOptions(id: number) {
  return queryOptions({
    queryKey: connectorKeys.detail(id),
    queryFn: ({ signal }) => apiRequest<McpServerDetail>(`/api/mcp/servers/${id}`, { signal }),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });
}
