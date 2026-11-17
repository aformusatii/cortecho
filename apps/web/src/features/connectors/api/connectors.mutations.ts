import type {
  McpOauthStartResponse,
  McpServerCreate,
  McpServerDetail,
  McpServerUpdate,
  McpToolPolicy,
} from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';
import { connectorKeys } from './connectors.queries.ts';

function invalidateConnectors(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
  void queryClient.invalidateQueries({ queryKey: connectorKeys.all });
  if (id !== undefined) void queryClient.invalidateQueries({ queryKey: connectorKeys.detail(id) });
  void queryClient.invalidateQueries({ queryKey: ['status'] });
}

export function useCreateConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: McpServerCreate) =>
      apiRequest<McpServerDetail>('/api/mcp/servers', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateConnectors(queryClient),
  });
}

export function useUpdateConnector(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: McpServerUpdate) =>
      apiRequest<McpServerDetail>(`/api/mcp/servers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(connectorKeys.detail(id), detail);
      invalidateConnectors(queryClient, id);
    },
  });
}

export function useDeleteConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateConnectors(queryClient),
  });
}

export function useReconnectConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest<McpServerDetail>(`/api/mcp/servers/${id}/reconnect`, { method: 'POST' }),
    onSettled: (_data, _error, id) => invalidateConnectors(queryClient, id),
  });
}

export function useRefreshConnectorTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest<McpServerDetail>(`/api/mcp/servers/${id}/tools/refresh`, { method: 'POST' }),
    onSuccess: (detail) => {
      queryClient.setQueryData(connectorKeys.detail(detail.id), detail);
      invalidateConnectors(queryClient, detail.id);
    },
  });
}

export function useSetToolPolicies(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policies: Record<string, McpToolPolicy>) =>
      apiRequest<McpServerDetail>(`/api/mcp/servers/${id}/tools`, {
        method: 'PATCH',
        body: JSON.stringify({ policies }),
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(connectorKeys.detail(id), detail);
      invalidateConnectors(queryClient, id);
    },
  });
}

export type TryToolResult = { ok: boolean; text: string; durationMs: number };

export function useTryTool(id: number) {
  return useMutation({
    mutationFn: ({
      name,
      args,
      confirm,
    }: {
      name: string;
      args: Record<string, unknown>;
      confirm: boolean;
    }) =>
      apiRequest<TryToolResult>(`/api/mcp/servers/${id}/tools/${encodeURIComponent(name)}/try`, {
        method: 'POST',
        body: JSON.stringify({ arguments: args, confirm }),
      }),
  });
}

export function useStartOAuth(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<McpOauthStartResponse>(`/api/mcp/servers/${id}/oauth/start`, { method: 'POST' }),
    onSettled: () => invalidateConnectors(queryClient, id),
  });
}

export function useCompleteOAuth(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callbackUrl: string) =>
      apiRequest<McpServerDetail>('/api/mcp/oauth/complete', {
        method: 'POST',
        body: JSON.stringify({ callbackUrl }),
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(connectorKeys.detail(id), detail);
      invalidateConnectors(queryClient, id);
    },
  });
}

export function useDisconnectOAuth(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<McpServerDetail>(`/api/mcp/servers/${id}/oauth/disconnect`, { method: 'POST' }),
    onSuccess: (detail) => {
      queryClient.setQueryData(connectorKeys.detail(id), detail);
      invalidateConnectors(queryClient, id);
    },
  });
}
