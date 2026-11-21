import type { OpenAiCheckResult, SetupDocument } from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';
import { setupKeys } from './setup.queries.ts';

function useSetupWrite(write: () => Promise<SetupDocument>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (document) => {
      queryClient.setQueryData(setupKeys.all, document);
      void queryClient.invalidateQueries({ queryKey: setupKeys.all });
    },
  });
}

/** The onboarding finished (or was already finished by the adopt route). */
export function useCompleteSetup() {
  return useSetupWrite(() => apiRequest<SetupDocument>('/api/setup/complete', { method: 'POST' }));
}

/** "Run the first-time setup again": forget the completion and show the steps. */
export function useRestartSetup() {
  return useSetupWrite(() => apiRequest<SetupDocument>('/api/setup/complete', { method: 'DELETE' }));
}

/**
 * "Check and continue" (spec §7.6). With a key it checks that key; without
 * one it checks the stored key, which is how the onboarding decides to skip
 * the OpenAI step.
 */
export function useCheckOpenAi() {
  return useMutation({
    mutationFn: (input: { apiKey?: string } = {}) =>
      apiRequest<OpenAiCheckResult>('/api/setup/check-openai', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}
