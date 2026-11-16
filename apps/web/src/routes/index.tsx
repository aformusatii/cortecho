import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '@/features/status/pages/StatusPage.tsx';

// Route files stay thin: the page lives in features/status.
export const Route = createFileRoute('/')({
  component: StatusPage,
});
