import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/pages/SettingsPage.tsx';

// Route files stay thin: the page lives in features/settings.
export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});
