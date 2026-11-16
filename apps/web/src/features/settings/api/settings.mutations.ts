import type { SettingsChange, SettingsDocument, SettingsPatch } from '@cortecho/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';
import { settingsKeys } from './settings.queries.ts';

/**
 * Every save answers with the new document, which is cached immediately so the
 * form adopts the server's values (normalised defaults, secrets stripped).
 * Health and the Echos pages read the settings version too.
 */
function useSettingsWrite<TInput>(write: (input: TInput) => Promise<SettingsDocument>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (document) => {
      queryClient.setQueryData(settingsKeys.document, document);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });
}

export function useSaveSettings() {
  return useSettingsWrite((input: SettingsPatch) =>
    apiRequest<SettingsDocument>('/api/settings', { method: 'PATCH', body: JSON.stringify(input) }),
  );
}

/** Applies one past change again (as a new change, so it lands in the history too). */
export function useRevertSettingsChange() {
  return useSettingsWrite((change: SettingsChange) =>
    apiRequest<SettingsDocument>(`/api/settings/changes/${change.id}/revert`, { method: 'POST' }),
  );
}
