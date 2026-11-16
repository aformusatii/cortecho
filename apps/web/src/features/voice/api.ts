import type { AskRequest, AskResponse, SayRequest, SayResponse } from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// The two test endpoints. Both create a turn, so the status page, an Echo's
// turn list and the health card all need a refresh.

export function useSay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SayRequest) =>
      apiRequest<SayResponse>('/api/say', { method: 'POST', body: JSON.stringify(input) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useAsk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AskRequest) =>
      apiRequest<AskResponse>('/api/ask', { method: 'POST', body: JSON.stringify(input) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
