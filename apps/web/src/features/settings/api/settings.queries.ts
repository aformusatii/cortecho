import type { InstructionsDocument, SettingsChange, SettingsDocument } from '@cortecho/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client.ts';

// Query keys are namespaced per feature: one invalidation of ['settings']
// refreshes the settings document, its history and the model list; ['devices']
// refreshes every Echo page.

export const settingsKeys = {
  all: ['settings'] as const,
  document: ['settings', 'document'] as const,
  changes: (limit: number, scope: string | null) => ['settings', 'changes', limit, scope] as const,
  instructions: ['settings', 'instructions'] as const,
  models: ['settings', 'models'] as const,
};

/** The live settings form: no polling, the version is carried by every save. */
export function settingsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.document,
    queryFn: ({ signal }) => apiRequest<SettingsDocument>('/api/settings', { signal }),
  });
}

export function settingsChangesQueryOptions(limit: number, scope: string | null, enabled = true) {
  const query = scope ? `&scope=${encodeURIComponent(scope)}` : '';
  return queryOptions({
    queryKey: settingsKeys.changes(limit, scope),
    queryFn: ({ signal }) =>
      apiRequest<SettingsChange[]>(`/api/settings/changes?limit=${limit}${query}`, { signal }),
    enabled,
  });
}

/** The assembled prompt `/api/ask` (no device) sends on its next request. */
export function settingsInstructionsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: settingsKeys.instructions,
    queryFn: ({ signal }) => apiRequest<InstructionsDocument>('/api/settings/instructions', { signal }),
    enabled,
    staleTime: 0,
  });
}

/**
 * OpenAI's current model ids for the model comboboxes. On failure the list is
 * empty and the fields stay free-text, so a missing key never blocks the form.
 */
export function openaiModelsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.models,
    queryFn: ({ signal }) => apiRequest<{ models: string[] }>('/api/openai/models', { signal }),
    staleTime: 10 * 60_000,
    retry: false,
  });
}
