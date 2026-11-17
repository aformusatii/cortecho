import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/pages/SettingsPage.tsx';

// Route files stay thin: the page lives in features/settings. The tab is in
// `?tab=`, so General and Connectors both deep-link (like the Echo page).
export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>) => {
    const server = Number(search.server);
    const auth = search.auth === 'ok' || search.auth === 'error' ? search.auth : undefined;
    return {
      tab: search.tab === 'connectors' ? ('connectors' as const) : ('general' as const),
      ...(Number.isInteger(server) && server > 0 ? { server } : {}),
      ...(auth ? { auth } : {}),
      ...(typeof search.reason === 'string' ? { reason: search.reason } : {}),
    };
  },
  component: SettingsPage,
});
