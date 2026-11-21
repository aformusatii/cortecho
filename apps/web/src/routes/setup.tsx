import { createFileRoute } from '@tanstack/react-router';
import { SetupPage } from '@/features/setup/pages/SetupPage.tsx';

// Route files stay thin: the page (and the Add Echo flow it hosts) lives in
// features/setup. M5 adds the onboarding steps to the same page.
export const Route = createFileRoute('/setup')({
  component: SetupPage,
});
